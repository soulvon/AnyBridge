// ES module (P3/P4) — escapeHtml 已迁至 ui/dom.js
import { escapeHtml, escAttr } from './ui/dom.js';
// ═══════ MODEL MAP (可编辑槽位映射 + 故障转移链) ═══════
globalThis.modelMapStore = { slots: [] };       // load_model_map 结果
globalThis.ideModels = null;               // list_ide_models 缓存（数组）
globalThis.ideMeta = null;                 // { source, capturedAt, account } 元信息
globalThis.modelMapSelectedIds = new Set(); // 批量勾选：modelUid
globalThis.modelMapBulkRunning = false;     // 批量操作防并发

globalThis.DEFAULT_PROXY_ENHANCEMENT = Object.freeze({
  retry: true,
  retryMaxRetries: 5,
  retryBaseMs: 600,
  retryCapMs: 8000,
  retryTotalSeconds: 60,
  selfHeal: Object.freeze({
    enabled: true,
    signature: true,
    budget: true,
    media: true,
  }),
  imageFallback: true,
  visionMaxTokens: 2048,
  visionContextMode: 'current',
  visionContextMaxChars: 8000,
  visionMultiImageMode: 'single',
  visionBatchSize: 3,
  webSearchEnabled: false,
  webSearchMaxResults: 5,
  webSearchMaxRounds: 3,
  autoRouting: true,
  unlockModels: true,
  systemPromptPrefix: '',
  systemPromptPrefixEnabled: false,
  customHeaders: [],
  customHeadersEnabled: false,
  responseHeaders: [],
  paramOverrides: {},
  paramOverridesEnabled: false,
  toolFilterMode: '',
  toolFilterList: [],
  forceToolChoice: '',
  toolFilterEnabled: false,
  rateLimitRpm: 0,
  rateLimitEnabled: false,
  requestLogging: false,
});
globalThis.PROXY_VISION_TEST_FALLBACK_IMAGE_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAIAAAACACAYAAADDPmHLAAABpklEQVR4nO3SMRHDUBBDwcAxiIAwYoNI/bk4IFTc6GYL1a/Qfq77+yY74cb7T7YTbrr/GT9gug8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAsBNA/YFpv/zAtA8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAMBOAPUHpv3yA9M+AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAOwHUH5j2yw9M+wAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAOwEcN2/N9kJN95/sp1w030AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB2Aqg/MO2XH5j2AQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA2Amg/sC0X35g2gcAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAGAngPoD0375gWkfAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAlQD+DY7JjtGCazMAAAAASUVORK5CYII=';
globalThis.proxyVisionPickerOpen = false;
globalThis.proxyVisionTestingKey = '';
globalThis.proxyVisionTestImageB64 = '';
globalThis.proxyVisionProviderSearch = '';
globalThis.proxyVisionSelectedProviderId = '';
globalThis.proxyVisionPickedModels = new Map();
globalThis.proxySearchSourcePickerOpen = false;
globalThis.proxySearchTestingId = '';
globalThis.lastSavedProxyEnhancement = null;

function defaultProxyEnhancement() {
  return { ...DEFAULT_PROXY_ENHANCEMENT, selfHeal: { ...DEFAULT_PROXY_ENHANCEMENT.selfHeal } };
}

function cloneModelMapStore(store = modelMapStore) {
  return JSON.parse(JSON.stringify(store || { slots: [] }));
}

function cloneProxyEnhancement(enhancement = modelMapStore?.enhancement) {
  return JSON.parse(JSON.stringify(enhancement || defaultProxyEnhancement()));
}

function normalizeHeaderPair(header) {
  return {
    key: String(header?.key || ''),
    value: String(header?.value || ''),
  };
}

function sanitizeHeaderPairsForPersist(headers) {
  return (Array.isArray(headers) ? headers : [])
    .map(normalizeHeaderPair)
    .map(h => ({ key: h.key.trim(), value: h.value }))
    .filter(h => h.key);
}

function modelMapForPersist() {
  const payload = cloneModelMapStore();
  if (!payload.enhancement || typeof payload.enhancement !== 'object') {
    payload.enhancement = defaultProxyEnhancement();
  }
  payload.enhancement.customHeaders = sanitizeHeaderPairsForPersist(payload.enhancement.customHeaders);
  payload.enhancement.responseHeaders = sanitizeHeaderPairsForPersist(payload.enhancement.responseHeaders);
  return payload;
}

async function getProxyVisionTestImageBase64() {
  if (proxyVisionTestImageB64) return proxyVisionTestImageB64;
  try {
    const res = await fetch('./assets/vision-test-image.png', { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    proxyVisionTestImageB64 = btoa(binary);
  } catch (e) {
    addLog('warn', '读取固定图片测试素材失败，使用内置兜底图: ' + e);
    proxyVisionTestImageB64 = PROXY_VISION_TEST_FALLBACK_IMAGE_B64;
  }
  return proxyVisionTestImageB64;
}

function ensureModelMapDefaults() {
  if (!modelMapStore || typeof modelMapStore !== 'object') modelMapStore = { slots: [] };
  if (!Array.isArray(modelMapStore.slots)) modelMapStore.slots = [];
  if (!Array.isArray(modelMapStore.injected)) modelMapStore.injected = [];
  // 本地代理"模型 ID 批量重命名"规则(由代理 tab → 模型列表列头齿轮按钮设置)
  const curRule = modelMapStore.proxyRouteRenameRule && typeof modelMapStore.proxyRouteRenameRule === 'object'
    ? modelMapStore.proxyRouteRenameRule : {};
  modelMapStore.proxyRouteRenameRule = {
    // 缺字段时默认 true:旧配置文件/老用户数据都按"启用规则"处理
    enabled: curRule.enabled !== false,
    mode: String(curRule.mode || ''),
    prefix: String(curRule.prefix || ''),
    suffix: String(curRule.suffix || ''),
    template: String(curRule.template || ''),
  };
  const cur = modelMapStore.enhancement && typeof modelMapStore.enhancement === 'object' ? modelMapStore.enhancement : {};
  const curSelfHeal = cur.selfHeal && typeof cur.selfHeal === 'object' ? cur.selfHeal : {};
  modelMapStore.enhancement = {
    retry: cur.retry !== false,
    retryMaxRetries: normalizeEnhancementInt(cur.retryMaxRetries, DEFAULT_PROXY_ENHANCEMENT.retryMaxRetries, 0),
    retryBaseMs: normalizeEnhancementInt(cur.retryBaseMs, DEFAULT_PROXY_ENHANCEMENT.retryBaseMs, 1),
    retryCapMs: normalizeEnhancementInt(cur.retryCapMs, DEFAULT_PROXY_ENHANCEMENT.retryCapMs, 1),
    retryTotalSeconds: normalizeEnhancementInt(cur.retryTotalSeconds, DEFAULT_PROXY_ENHANCEMENT.retryTotalSeconds, 1),
    selfHeal: {
      enabled: curSelfHeal.enabled !== false,
      signature: curSelfHeal.signature !== false,
      budget: curSelfHeal.budget !== false,
      media: curSelfHeal.media !== false,
    },
    imageFallback: cur.imageFallback !== false,
    visionMaxTokens: normalizeEnhancementInt(cur.visionMaxTokens, DEFAULT_PROXY_ENHANCEMENT.visionMaxTokens, 64),
    visionContextMode: ['current', 'summary', 'full'].includes(String(cur.visionContextMode || '')) ? String(cur.visionContextMode) : DEFAULT_PROXY_ENHANCEMENT.visionContextMode,
    visionContextMaxChars: normalizeEnhancementInt(cur.visionContextMaxChars, DEFAULT_PROXY_ENHANCEMENT.visionContextMaxChars, 500),
    visionMultiImageMode: ['single', 'batch', 'chunk'].includes(String(cur.visionMultiImageMode || '')) ? String(cur.visionMultiImageMode) : DEFAULT_PROXY_ENHANCEMENT.visionMultiImageMode,
    visionBatchSize: normalizeEnhancementInt(cur.visionBatchSize, DEFAULT_PROXY_ENHANCEMENT.visionBatchSize, 1),
    webSearchEnabled: cur.webSearchEnabled === true,
    webSearchMaxResults: normalizeEnhancementInt(cur.webSearchMaxResults, DEFAULT_PROXY_ENHANCEMENT.webSearchMaxResults, 1),
    webSearchMaxRounds: normalizeEnhancementInt(cur.webSearchMaxRounds, DEFAULT_PROXY_ENHANCEMENT.webSearchMaxRounds, 1),
    autoRouting: cur.autoRouting !== false,
    unlockModels: cur.unlockModels !== false,
    systemPromptPrefix: String(cur.systemPromptPrefix || ''),
    systemPromptPrefixEnabled: cur.systemPromptPrefixEnabled === true,
    customHeaders: Array.isArray(cur.customHeaders) ? cur.customHeaders.map(normalizeHeaderPair) : [],
    customHeadersEnabled: cur.customHeadersEnabled === true,
    responseHeaders: Array.isArray(cur.responseHeaders) ? cur.responseHeaders.map(normalizeHeaderPair) : [],
    paramOverrides: cur.paramOverrides && typeof cur.paramOverrides === 'object' ? cur.paramOverrides : {},
    paramOverridesEnabled: cur.paramOverridesEnabled === true,
    toolFilterMode: String(cur.toolFilterMode || ''),
    toolFilterList: Array.isArray(cur.toolFilterList) ? cur.toolFilterList.map(String) : [],
    forceToolChoice: String(cur.forceToolChoice || ''),
    toolFilterEnabled: cur.toolFilterEnabled === true,
    rateLimitRpm: normalizeEnhancementInt(cur.rateLimitRpm, 0, 0),
    rateLimitEnabled: cur.rateLimitEnabled === true,
    requestLogging: cur.requestLogging === true,
  };
  if (!modelMapStore.visionModels || typeof modelMapStore.visionModels !== 'object') {
    modelMapStore.visionModels = { imageModels: [] };
  }
  if (!Array.isArray(modelMapStore.visionModels.imageModels)) {
    modelMapStore.visionModels.imageModels = [];
  }
  const seen = new Set();
  modelMapStore.visionModels.imageModels = modelMapStore.visionModels.imageModels
    .map(x => ({
      providerId: String(x?.providerId || '').trim(),
      model: String(x?.model || '').trim(),
      apiFormat: normalizeMappingApiFormat(x?.apiFormat || x?.api_format) || 'openai'
    }))
    .filter(x => x.providerId && x.model)
    .filter(x => {
      const key = visionModelKey(x.providerId, x.model, x.apiFormat);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  if (!modelMapStore.searchModels || typeof modelMapStore.searchModels !== 'object') {
    modelMapStore.searchModels = { searchSources: [] };
  }
  if (!Array.isArray(modelMapStore.searchModels.searchSources)) {
    modelMapStore.searchModels.searchSources = [];
  }
  const seenSearchSources = new Set();
  modelMapStore.searchModels.searchSources = modelMapStore.searchModels.searchSources
    .map((x, idx) => {
      const provider = String(x?.provider || x?.engine || '').trim().toLowerCase();
      const engine = String(x?.engine || '').trim().toLowerCase();
      const kind = String(x?.type || (engine ? 'engine' : 'api')).trim().toLowerCase();
      return {
        id: String(x?.id || `src-${Date.now()}-${idx}`).trim(),
        name: String(x?.name || searchSourceDisplayName(provider || engine)).trim(),
        type: kind === 'engine' ? 'engine' : 'api',
        provider: provider && kind !== 'engine' ? provider : '',
        engine: engine || (kind === 'engine' ? provider : ''),
        apiKey: String(x?.apiKey || '').trim(),
        apiHost: String(x?.apiHost || '').trim(),
        enabled: x?.enabled !== false,
      };
    })
    .filter(x => x.id && (x.provider || x.engine))
    .filter(x => {
      const key = x.id;
      if (seenSearchSources.has(key)) return false;
      seenSearchSources.add(key);
      return true;
    });
  if (typeof syncProxyEnhancementSummary === 'function') syncProxyEnhancementSummary();
}

function normalizeEnhancementInt(value, fallback, min) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n >= min ? n : fallback;
}

function visionModelKey(providerId, model, apiFormat = 'openai') {
  return `${encodeURIComponent(providerId || '')}|${encodeURIComponent(model || '')}|${encodeURIComponent(normalizeMappingApiFormat(apiFormat) || 'openai')}`;
}

function decodeVisionModelKey(key) {
  const [providerId = '', model = '', apiFormat = 'openai'] = String(key || '').split('|');
  return {
    providerId: decodeURIComponent(providerId),
    model: decodeURIComponent(model),
    apiFormat: normalizeMappingApiFormat(decodeURIComponent(apiFormat)) || 'openai'
  };
}

function visionModelLabel(item) {
  const p = (providerStore.providers || []).find(x => x.id === item.providerId);
  return `${p ? (p.name || p.id) : (item.providerId || '未知供应商')} - ${item.model || '默认模型'} · ${targetRouteLabel(item)}`;
}
async function ensureIdeModels(options = {}) {
  const force = options === true || !!(options && options.force);
  if (ideModels && !force) return ideModels;
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

async function refreshIdeModels(options = {}) {
  const quiet = !!(options && options.quiet);
  const rerender = !(options && options.rerender === false);
  const btn = quiet ? null : document.getElementById('btn-refresh-models');
  try {
    if (btn) { btn.disabled = true; btn.querySelector('span') && (btn.querySelector('span').textContent = '拉取中...'); }
    const target = getTargetIde();
    const info = await invoke('refresh_ide_models', { target });
    const refreshed = await invoke('list_ide_models');
    if (refreshed && Array.isArray(refreshed.models)) {
      ideModels = refreshed.models;
    } else {
      ideModels = info.models || [];
    }
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
    if (rerender) {
      maybeAutoSelectRecommendedSlot();
      renderSlotCatalogList();
      if (document.getElementById('page-model-slots')?.classList.contains('active')) {
        await renderInjectedList();
      }
    }
    if (!quiet) addLog('info', `模型列表已更新：${info.email} (${info.plan_name})，${info.models.length} 个模型`);
    return true;
  } catch (e) {
    addLog(quiet ? 'warn' : 'error', `${quiet ? '自动同步当前账号模型列表失败' : '刷新模型列表失败'}: ${e}`);
    return false;
  } finally {
    if (btn) { btn.disabled = false; btn.querySelector('span') && (btn.querySelector('span').textContent = '刷新'); }
  }
}

async function syncCurrentIdeModels(options = {}) {
  const ok = await refreshIdeModels({ quiet: true, rerender: false, ...(options || {}) });
  if (!ok) await ensureIdeModels({ force: true });
  return ok;
}

// 由 modelUid 找原始名（查不到回退到 uid 本身）
function originalNameOf(uid) {
  const m = (ideModels || []).find(x => x.id === uid);
  return m ? m.name : uid;
}

// ── 品牌检测与快速筛选 ──
globalThis.MODEL_BRANDS = [
  { id: 'claude', label: 'Claude', match: /claude|opus|sonnet|haiku|fable/i },
  { id: 'gpt', label: 'GPT', match: /gpt|o1\b|o3\b|o4\b|codex/i },
  { id: 'gemini', label: 'Gemini', match: /gemini/i },
  { id: 'grok', label: 'Grok', match: /grok|xai/i },
  { id: 'deepseek', label: 'DeepSeek', match: /deepseek/i },
  { id: 'kimi', label: 'Kimi', match: /kimi|moonshot/i },
  { id: 'qwen', label: 'Qwen', match: /qwen|tongyi/i },
  { id: 'minimax', label: 'MiniMax', match: /minimax/i },
  { id: 'glm', label: 'GLM', match: /glm|chatglm|zhipu/i },
];

function detectModelBrand(name, uid) {
  const hay = `${name || ''} ${uid || ''}`;
  for (const b of MODEL_BRANDS) {
    if (b.match.test(hay)) return b.id;
  }
  return 'other';
}

function getAvailableBrands(items, getName, getUid) {
  const set = new Set();
  items.forEach(item => {
    const brand = detectModelBrand(getName(item), getUid(item));
    if (brand !== 'other') set.add(brand);
  });
  return MODEL_BRANDS.filter(b => set.has(b.id));
}

// 排序/筛选状态
globalThis.slotCatalogBrand = '';
globalThis.slotCatalogSort = 'name-asc';
globalThis.mappingCatalogProvider = '';
globalThis.mappingCatalogSort = 'name-asc';

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
    const routeText = targetRouteLabel(t);
    const badges = p ? capabilityBadges(p, true, t.model || p.defaultModel || null) : '';
    const caps = badges || (invalid ? '<span class="target-cap-muted">供应商不可用</span>' : '<span class="target-cap-muted">未标记能力</span>');
    return `
      <div class="target-chain-item${invalid ? ' invalid' : ''}" title="${invalid ? '供应商不存在或未启用' : '配置故障转移分流目标'}">
        <div class="target-model-line">
          <span class="target-order">${i + 1}</span>
          <span class="target-model-text">${modelText}</span>
          <span class="target-cap-muted">${escAttr(routeText)}</span>
          ${invalid ? '<span class="target-warning">⚠</span>' : ''}
        </div>
        <div class="target-cap-line">${caps}</div>
      </div>`;
  }).join('')}</div>`;
}

async function renderModelMap() {
  const body = document.getElementById('modelMapBody');
  if (!body) return;
  await ensureIdeModels({ force: true });
  await ensureInjected();
  try {
    const res = await invoke('load_model_map');
    modelMapStore = (res && Array.isArray(res.slots)) ? res : { slots: [] };
  } catch (e) {
    modelMapStore = { slots: [] };
    addLog('warn', '加载模型映射失败: ' + e);
  }

  ensureModelMapDefaults();
  lastSavedProxyEnhancement = cloneProxyEnhancement();

  // 同步 namePrefix 到输入框
  // 兼容旧 model-map.json（无 injected 字段）
  modelMapStore.unlockScope = normalizeUnlockScope(modelMapStore.unlockScope || modelMapStore.slotDisplayMode);
  modelMapStore.slotDisplayMode = modelMapStore.unlockScope;
  modelMapStore.slotVisibilityMode = normalizeSlotVisibilityMode(modelMapStore.slotVisibilityMode);
  ensureSlotVisibilityArray();
  const badge = document.getElementById('injected-count-badge');
  if (badge) badge.textContent = '槽位管理';

  const slots = modelMapStore.slots || [];
  const rows = slots.map(s => ({ kind: 'mapped', slot: s, model: slotModelOf(s.modelUid) }));
  if (rows.length === 0) {
    body.innerHTML = '<tr><td colspan="7" style="text-align:center;color:var(--text-muted);padding:18px">暂无模型映射，点击「添加映射」创建第一条关系</td></tr>';
    syncModelMapSelectionState();
    return;
  }

  body.innerHTML = rows.map(row => {
    const s = row.slot;
    const orig = originalNameOf(s.modelUid);
    const customName = s.displayName && s.displayName.trim();
    const baseName = customName || orig;
    const prefix = (modelMapStore.namePrefix || '').trim();
    const tpl = (modelMapStore.labelTemplate || '').trim();
    const firstTarget = (s.targets && s.targets[0]) || null;
    const providerName = firstTarget ? providerNameOf(firstTarget.providerId) : '';
    const apiModel = firstTarget ? firstTarget.model : '';
    const display = renderLabelTemplate(tpl, {
      prefix, label: baseName, provider: providerName, apiModel
    });
    const chain = (s.targets && s.targets.length)
      ? renderTargetChain(s.targets)
      : `<span style="color:var(--warn,#d97706);cursor:pointer" data-action="openFailoverEditor" data-arg="${escAttr(s.modelUid)}">未设置 ⚠ [点击配置]</span>`;
    const vision = slotVisionAssessment(s.modelUid, s.targets || [], s.supportsImages !== false);
    const enabled = s.enabled !== false;
    const hasVisionModels = (modelMapStore.visionModels?.imageModels?.length || 0) > 0;
    const useThirdParty = s.useThirdPartyVision === true;
    const visionDisabled = !hasVisionModels ? 'disabled' : '';
    const visionTitle = !hasVisionModels
      ? '请先在「代理增强」中配置图片理解模型'
      : (useThirdParty ? '已启用第三方图片理解' : '启用后图片将使用第三方模型理解');
    const selected = modelMapSelectedIds.has(s.modelUid);
    return `
      <tr data-model-uid="${escAttr(s.modelUid)}" data-row-kind="mapped" class="${selected ? 'is-selected' : ''}">
        <td class="model-map-select-cell" data-action="__noop" data-stop>
          <label class="provider-select-check provider-select-check-table" title="选择此映射" data-action="__noop" data-stop>
            <input type="checkbox" class="model-map-row-check" data-uid="${escAttr(s.modelUid)}" ${selected ? 'checked' : ''} data-action="toggleModelMapSelection" data-events="change" data-args="[&quot;${escAttr(s.modelUid)}&quot;]" data-pass-checked data-pass-event>
            <span></span>
          </label>
        </td>
        <td class="editable-cell display-name-cell" data-action="startEditDisplayName" data-args="[&quot;${escAttr(s.modelUid)}&quot;]" data-pass-this title="${escAttr(display)}">${escAttr(display)}</td>
        <td>
          <div>${escAttr(orig)}</div>
          <div style="margin-top:3px;">${renderVisionPill(vision, true)}</div>
        </td>
        <td class="model-target-cell" data-action="openFailoverEditor" data-arg="${escAttr(s.modelUid)}" title="配置故障转移分流目标">${chain}</td>
        <td>
          <div class="model-map-actions">
            <button class="btn-icon model-map-action-btn" data-action="openSlotEditor" data-arg="${escAttr(s.modelUid)}" title="编辑映射" aria-label="编辑映射">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
            </button>
            <button class="btn-icon model-map-action-btn danger" data-action="deleteSlot" data-arg="${escAttr(s.modelUid)}" title="删除映射" aria-label="删除映射">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2"/></svg>
            </button>
          </div>
        </td>
        <td class="model-map-toggle-cell">
          <label class="toggle-switch" title="${escAttr(visionTitle)}">
            <input type="checkbox" ${useThirdParty ? 'checked' : ''} ${visionDisabled} data-action="toggleSlotThirdPartyVision" data-events="change" data-args="[&quot;${escAttr(s.modelUid)}&quot;]" data-pass-checked>
            <span class="toggle-slider"></span>
          </label>
        </td>
        <td class="model-map-toggle-cell">
          <label class="toggle-switch" title="${enabled ? '已启用，点击停用' : '已停用，点击启用'}">
            <input type="checkbox" ${enabled ? 'checked' : ''} data-action="toggleSlotEnabled" data-events="change" data-arg="${escAttr(s.modelUid)}">
            <span class="toggle-slider"></span>
          </label>
        </td>
      </tr>`;
  }).join('');

  // 渲染后立即应用当前的过滤器与搜索关键字
  filterModelTable();
  syncModelMapSelectionState();
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
function filterModelTable() {
  const searchInput = document.getElementById('model-search-input');
  const query = searchInput ? searchInput.value.toLowerCase().trim() : '';

  const body = document.getElementById('modelMapBody');
  if (!body) return;

  const rows = body.getElementsByTagName('tr');

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];

    // 跳过空数据提示行
    if (row.cells.length === 1 && row.cells[0].colSpan >= 7) {
      continue;
    }

    // cells[0]=复选框 cells[1]=显示名 cells[2]=原模型名
    const display = (row.cells[1]?.textContent || '').toLowerCase();
    const orig = (row.cells[2]?.textContent || '').toLowerCase();
    const slot = (row.dataset.modelUid || '').toLowerCase();

    // 搜索匹配
    const matchesSearch = query === '' ||
      orig.includes(query) ||
      display.includes(query) ||
      slot.includes(query);

    if (matchesSearch) {
      row.style.display = '';
    } else {
      row.style.display = 'none';
    }
  }
  syncModelMapSelectionState();
}

async function persistModelMap() {
  try {
    ensureModelMapDefaults();
    await invoke('save_model_map', { map: modelMapForPersist() });
    lastSavedProxyEnhancement = cloneProxyEnhancement();
    return true;
  } catch (e) {
    addLog('err', '保存映射失败: ' + e);
    showCustomAlert('保存映射失败：' + e, '保存失败', 'error');
    return false;
  }
}


// ─── 模型映射批量勾选 / 批量操作 ───
// 选区：仅包含 modelMapStore.slots 中真实存在的 modelUid（避免指向已删除行）
function cleanupModelMapSelection() {
  const valid = new Set((modelMapStore.slots || []).map(s => s.modelUid));
  modelMapSelectedIds.forEach(uid => {
    if (!valid.has(uid)) modelMapSelectedIds.delete(uid);
  });
}

function toggleModelMapSelection(uid, checked, event) {
  if (event) event.stopPropagation();
  if (!uid) return;
  if (checked) modelMapSelectedIds.add(uid);
  else modelMapSelectedIds.delete(uid);
  // 同步行高亮
  const row = document.querySelector(`#modelMapBody tr[data-model-uid="${CSS.escape(uid)}"]`);
  if (row) row.classList.toggle('is-selected', checked);
  syncModelMapSelectionState();
}

function visibleModelMapSlots() {
  // 搜索/过滤后仍可见的行
  return Array.from(document.querySelectorAll('#modelMapBody tr[data-row-kind="mapped"]'))
    .filter(row => row.style.display !== 'none')
    .map(row => row.dataset.modelUid)
    .filter(Boolean);
}

function toggleVisibleModelMapSelectionFromHeader(checked) {
  // 表头全选框的勾选态由 syncModelMapSelectionState 校正，传入的 checked 仅作参考
  const visible = visibleModelMapSlots();
  if (!visible.length) return;
  const allSelected = visible.length > 0 && visible.every(uid => modelMapSelectedIds.has(uid));
  visible.forEach(uid => {
    if (allSelected) modelMapSelectedIds.delete(uid);
    else modelMapSelectedIds.add(uid);
  });
  renderModelMap();
}

function toggleVisibleModelMapSelection() {
  // 工具栏的「选择当前」按钮：若当前可见行已全选则取消，否则全选当前
  const visible = visibleModelMapSlots();
  if (!visible.length) return;
  const allSelected = visible.every(uid => modelMapSelectedIds.has(uid));
  visible.forEach(uid => {
    if (allSelected) modelMapSelectedIds.delete(uid);
    else modelMapSelectedIds.add(uid);
  });
  renderModelMap();
}

function syncModelMapSelectionState() {
  cleanupModelMapSelection();
  const total = (modelMapStore.slots || []).length;
  const selected = modelMapSelectedIds.size;
  const countEl = document.getElementById('modelMapBulkCount');
  if (countEl) {
    countEl.textContent = selected
      ? `已选择 ${selected} / ${total}`
      : `共 ${total} 个`;
    countEl.classList.toggle('is-active', selected > 0);
  }
  const disabled = modelMapBulkRunning || selected === 0;
  ['modelMapBulkEnableBtn', 'modelMapBulkDisableBtn', 'modelMapBulkVisionBtn', 'modelMapBulkDeleteBtn'].forEach(id => {
    const btn = document.getElementById(id);
    if (btn) btn.disabled = disabled;
  });
  // 工具栏的「选择当前」按钮
  const selectVisibleBtn = document.getElementById('modelMapSelectVisibleBtn');
  const visibleIds = visibleModelMapSlots();
  if (selectVisibleBtn) {
    selectVisibleBtn.disabled = modelMapBulkRunning || visibleIds.length === 0;
    selectVisibleBtn.textContent = visibleIds.length && visibleIds.every(uid => modelMapSelectedIds.has(uid))
      ? '取消当前'
      : '选择当前';
  }
  // 表头全选框的 indeterminate 与 checked 态
  const selectAll = document.getElementById('modelMapSelectAll');
  if (selectAll) {
    const visibleSelectedCount = visibleIds.filter(uid => modelMapSelectedIds.has(uid)).length;
    if (visibleIds.length === 0) {
      selectAll.checked = false;
      selectAll.indeterminate = false;
      selectAll.disabled = true;
    } else {
      selectAll.disabled = false;
      selectAll.checked = visibleSelectedCount === visibleIds.length;
      selectAll.indeterminate = visibleSelectedCount > 0 && visibleSelectedCount < visibleIds.length;
    }
  }
}

async function batchSetSelectedSlotsEnabled(enabled) {
  if (modelMapBulkRunning) return;
  cleanupModelMapSelection();
  const targets = (modelMapStore.slots || []).filter(s => modelMapSelectedIds.has(s.modelUid));
  if (!targets.length) return;
  modelMapBulkRunning = true;
  syncModelMapSelectionState();
  const prevMap = new Map(targets.map(s => [s.modelUid, s.enabled !== false]));
  let okCount = 0;
  try {
    targets.forEach(s => { s.enabled = enabled === true; });
    if (await persistModelMap()) {
      okCount = targets.length;
      addLog('ok', `已${enabled ? '启用' : '停用'} ${okCount} 个模型映射`);
      if (typeof showBottomToast === 'function') {
        showBottomToast(`已${enabled ? '启用' : '停用'} ${okCount} 个模型映射`, 'success');
      }
    } else {
      prevMap.forEach((prev, uid) => {
        const s = modelMapStore.slots.find(x => x.modelUid === uid);
        if (s) s.enabled = prev;
      });
    }
  } catch (e) {
    prevMap.forEach((prev, uid) => {
      const s = modelMapStore.slots.find(x => x.modelUid === uid);
      if (s) s.enabled = prev;
    });
    addLog('err', `批量${enabled ? '启用' : '停用'}失败: ` + e);
    showCustomAlert(String(e), '批量操作失败', 'error');
  } finally {
    modelMapBulkRunning = false;
    await renderModelMap();
  }
}

async function batchSetSelectedSlotsThirdPartyVision(enabled) {
  if (modelMapBulkRunning) return;
  cleanupModelMapSelection();
  const hasVisionModels = (modelMapStore.visionModels?.imageModels?.length || 0) > 0;
  if (!hasVisionModels) {
    showCustomAlert('请先在「代理增强」中配置图片理解模型。', '无法启用', 'warn');
    return;
  }
  const targets = (modelMapStore.slots || []).filter(s => modelMapSelectedIds.has(s.modelUid));
  if (!targets.length) return;
  modelMapBulkRunning = true;
  syncModelMapSelectionState();
  const prevMap = new Map(targets.map(s => [s.modelUid, s.useThirdPartyVision === true]));
  let okCount = 0;
  try {
    targets.forEach(s => { s.useThirdPartyVision = enabled === true; });
    if (await persistModelMap()) {
      okCount = targets.length;
      addLog('ok', `已为 ${okCount} 个映射${enabled ? '启用' : '关闭'}第三方图片理解`);
      if (typeof showBottomToast === 'function') {
        showBottomToast(`已${enabled ? '启用' : '关闭'} ${okCount} 个映射的第三方图片理解`, 'success');
      }
    } else {
      prevMap.forEach((prev, uid) => {
        const s = modelMapStore.slots.find(x => x.modelUid === uid);
        if (s) s.useThirdPartyVision = prev;
      });
    }
  } catch (e) {
    prevMap.forEach((prev, uid) => {
      const s = modelMapStore.slots.find(x => x.modelUid === uid);
      if (s) s.useThirdPartyVision = prev;
    });
    addLog('err', `批量${enabled ? '启用' : '关闭'}第三方图片理解失败: ` + e);
    showCustomAlert(String(e), '批量操作失败', 'error');
  } finally {
    modelMapBulkRunning = false;
    await renderModelMap();
  }
}

async function batchDeleteSelectedSlots() {
  if (modelMapBulkRunning) return;
  cleanupModelMapSelection();
  const targets = (modelMapStore.slots || []).filter(s => modelMapSelectedIds.has(s.modelUid));
  if (!targets.length) return;
  modelMapBulkRunning = true;
  syncModelMapSelectionState();
  const removedUids = new Set(targets.map(s => s.modelUid));
  const prev = modelMapStore.slots.slice();
  let okCount = 0;
  try {
    modelMapStore.slots = modelMapStore.slots.filter(s => !removedUids.has(s.modelUid));
    if (await persistModelMap()) {
      okCount = targets.length;
      removedUids.forEach(uid => modelMapSelectedIds.delete(uid));
      addLog('info', `已删除 ${okCount} 个模型映射`);
      if (typeof showBottomToast === 'function') {
        showBottomToast(`已删除 ${okCount} 个模型映射`, 'success');
      }
    } else {
      modelMapStore.slots = prev;
    }
  } catch (e) {
    modelMapStore.slots = prev;
    addLog('err', '批量删除失败: ' + e);
    showCustomAlert(String(e), '批量操作失败', 'error');
  } finally {
    modelMapBulkRunning = false;
    await renderModelMap();
  }
}





// ─── 代理增强配置面板 ───
function renderProxyEnhancement() {
  ensureModelMapDefaults();
  const e = modelMapStore.enhancement;
  ['retry', 'imageFallback', 'autoRouting', 'unlockModels', 'requestLogging',
    'systemPromptPrefixEnabled', 'customHeadersEnabled', 'toolFilterEnabled',
    'paramOverridesEnabled', 'rateLimitEnabled', 'webSearchEnabled'].forEach(key => {
    const el = document.getElementById(`enhancement-${key}`);
    if (el) el.checked = e[key] === true;
  });
  ['retryMaxRetries', 'retryBaseMs', 'retryCapMs', 'retryTotalSeconds', 'rateLimitRpm', 'visionBatchSize', 'visionContextMaxChars', 'webSearchMaxResults', 'webSearchMaxRounds'].forEach(key => {
    const el = document.getElementById(`enhancement-${key}`);
    if (el) el.value = e[key];
  });
  ['visionMaxTokens', 'visionContextMode', 'visionMultiImageMode'].forEach(key => {
    const el = document.getElementById(`enhancement-${key}`);
    if (el) el.value = String(e[key] || DEFAULT_PROXY_ENHANCEMENT[key]);
  });
  ['enabled', 'signature', 'budget', 'media'].forEach(key => {
    const el = document.getElementById(`enhancement-selfHeal-${key}`);
    if (el) el.checked = e.selfHeal?.[key] !== false;
  });
  setRetryConfigControlsEnabled(e.retry !== false);
  setSelfHealControlsEnabled(e.selfHeal?.enabled !== false);
  setPanelControlsEnabled('systemPromptPrefix', e.systemPromptPrefixEnabled === true);
  setPanelControlsEnabled('customHeaders', e.customHeadersEnabled === true);
  setPanelControlsEnabled('toolFilter', e.toolFilterEnabled === true);
  setPanelControlsEnabled('paramOverrides', e.paramOverridesEnabled === true);
  setPanelControlsEnabled('rateLimit', e.rateLimitEnabled === true);
  setVisionOptionControlsEnabled(e.imageFallback !== false);
  setVisionBatchSizeEnabled(e.visionMultiImageMode === 'chunk' && e.imageFallback !== false);

  const sp = document.getElementById('enhancement-systemPromptPrefix');
  if (sp) sp.value = e.systemPromptPrefix || '';

  const tfm = document.getElementById('enhancement-toolFilterMode');
  if (tfm) tfm.value = e.toolFilterMode || '';
  const tfl = document.getElementById('enhancement-toolFilterList');
  if (tfl) tfl.value = (e.toolFilterList || []).join(', ');

  const ftc = document.getElementById('enhancement-forceToolChoice');
  if (ftc) ftc.value = e.forceToolChoice || '';

  const po = document.getElementById('enhancement-paramOverrides');
  if (po) {
    const obj = e.paramOverrides || {};
    const keys = Object.keys(obj);
    po.value = keys.length ? keys.map(k => `${k}=${JSON.stringify(obj[k])}`).join('\n') : '';
  }

  renderHeaderList('customHeaders', modelMapStore.enhancement.customHeaders);
  renderHeaderList('responseHeaders', modelMapStore.enhancement.responseHeaders);
  setPanelControlsEnabled('customHeaders', e.customHeadersEnabled === true);

  renderProxyVisionModelList();
  renderVisionModelPicker();
  renderProxySearchSourceList();
  renderSearchSourcePicker();
}

function renderHeaderList(field, headers) {
  const wrap = document.getElementById(`enhancement-${field}-list`);
  if (!wrap) return;
  const items = Array.isArray(headers) ? headers : [];
  if (!items.length) {
    wrap.innerHTML = '<div style="padding:10px;color:var(--text-muted);font-size:12px;">暂无自定义头部</div>';
    return;
  }
  wrap.innerHTML = items.map((h, i) =>
    '<div class="header-pair-row" style="display:flex;gap:6px;align-items:center;margin-bottom:6px;">' +
    '<input type="text" value="' + escapeHtml(h.key || '') + '" placeholder="Header 名" style="flex:1;min-width:0;" data-action="updateHeaderPair" data-events="change" data-args="[&quot;' + field + '&quot;,' + i + ',&quot;key&quot;]" data-pass-value />' +
    '<input type="text" value="' + escapeHtml(h.value || '') + '" placeholder="Header 值" style="flex:1;min-width:0;" data-action="updateHeaderPair" data-events="change" data-args="[&quot;' + field + '&quot;,' + i + ',&quot;value&quot;]" data-pass-value />' +
    '<button class="btn btn-sm btn-danger" data-action="removeHeaderPair" data-args="[&quot;' + field + '&quot;,' + i + ']" title="删除">✕</button>' +
    '</div>'
  ).join('');
}

function addHeaderPair(field) {
  ensureModelMapDefaults();
  if (!Array.isArray(modelMapStore.enhancement[field])) modelMapStore.enhancement[field] = [];
  modelMapStore.enhancement[field].push({ key: '', value: '' });
  renderHeaderList(field, modelMapStore.enhancement[field]);
  autoSaveEnhancement();
}

function updateHeaderPair(field, idx, prop, value) {
  ensureModelMapDefaults();
  const arr = modelMapStore.enhancement[field];
  if (arr && arr[idx]) arr[idx][prop] = value;
  autoSaveEnhancement();
}

function removeHeaderPair(field, idx) {
  ensureModelMapDefaults();
  const arr = modelMapStore.enhancement[field];
  if (arr) { arr.splice(idx, 1); renderHeaderList(field, arr); }
  autoSaveEnhancement();
}

function updateEnhancementText(input, key) {
  ensureModelMapDefaults();
  modelMapStore.enhancement[key] = input.value;
  autoSaveEnhancement();
}

function updateEnhancementSelect(select, key) {
  ensureModelMapDefaults();
  modelMapStore.enhancement[key] = select.value;
  autoSaveEnhancement();
}

function updateParamOverrides(textarea) {
  ensureModelMapDefaults();
  const text = textarea.value.trim();
  if (!text) { modelMapStore.enhancement.paramOverrides = {}; autoSaveEnhancement(); return; }
  const obj = {};
  for (const line of text.split('\n')) {
    const m = line.match(/^(\w+)\s*=\s*(.+)$/);
    if (m) {
      try { obj[m[1]] = JSON.parse(m[2]); }
      catch { obj[m[1]] = m[2]; }
    }
  }
  modelMapStore.enhancement.paramOverrides = obj;
  autoSaveEnhancement();
}

function updateToolFilterList(input) {
  ensureModelMapDefaults();
  modelMapStore.enhancement.toolFilterList = input.value.split(',').map(s => s.trim()).filter(Boolean);
  autoSaveEnhancement();
}

function openProxyEnhancement() {
  ensureModelMapDefaults();
  proxyVisionPickerOpen = false;
  const picker = document.getElementById('proxyVisionModelPicker');
  if (picker) {
    picker.classList.remove('is-open');
    picker.setAttribute('aria-hidden', 'true');
  }
  if (typeof openProxyPanel === 'function') {
    openProxyPanel('enhancement');
    renderProxyEnhancement();
    return;
  }
  renderProxyEnhancement();
  document.getElementById('proxyEnhancementModal')?.classList.add('is-open');
}

function closeProxyEnhancement() {
  document.getElementById('proxyEnhancementModal')?.classList.remove('is-open');
}

function toggleEnhancement(input, key) {
  ensureModelMapDefaults();
  if (!Object.prototype.hasOwnProperty.call(DEFAULT_PROXY_ENHANCEMENT, key)) return;
  modelMapStore.enhancement[key] = input.checked === true;
  if (key === 'retry') setRetryConfigControlsEnabled(modelMapStore.enhancement.retry !== false);
  // 面板开关：切换时启用/禁用对应输入控件
  if (key === 'systemPromptPrefixEnabled') setPanelControlsEnabled('systemPromptPrefix', input.checked);
  if (key === 'customHeadersEnabled') setPanelControlsEnabled('customHeaders', input.checked);
  if (key === 'toolFilterEnabled') setPanelControlsEnabled('toolFilter', input.checked);
  if (key === 'paramOverridesEnabled') setPanelControlsEnabled('paramOverrides', input.checked);
  if (key === 'rateLimitEnabled') setPanelControlsEnabled('rateLimit', input.checked);
  if (key === 'imageFallback') {
    setVisionOptionControlsEnabled(input.checked === true);
    setVisionBatchSizeEnabled(input.checked === true && modelMapStore.enhancement.visionMultiImageMode === 'chunk');
  }
  autoSaveEnhancement();
}

function toggleSelfHeal(input, key) {
  ensureModelMapDefaults();
  if (!['enabled', 'signature', 'budget', 'media'].includes(key)) return;
  modelMapStore.enhancement.selfHeal[key] = input.checked === true;
  if (key === 'enabled') setSelfHealControlsEnabled(input.checked === true);
  autoSaveEnhancement();
}

function setPanelControlsEnabled(panel, enabled) {
  const map = {
    systemPromptPrefix: ['enhancement-systemPromptPrefix'],
    customHeaders: ['enhancement-customHeaders-list', 'enhancement-responseHeaders-list'],
    toolFilter: ['enhancement-toolFilterMode', 'enhancement-toolFilterList', 'enhancement-forceToolChoice'],
    paramOverrides: ['enhancement-paramOverrides'],
    rateLimit: ['enhancement-rateLimitRpm'],
  };
  const ids = map[panel] || [];
  ids.forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    if ('disabled' in el) el.disabled = !enabled;
    el.querySelectorAll?.('input, textarea, select, button').forEach(child => {
      child.disabled = !enabled;
    });
  });
  // 自定义请求头的添加按钮
  if (panel === 'customHeaders') {
    document.querySelectorAll('[data-action="addHeaderPair"]').forEach(btn => { btn.disabled = !enabled; });
  }
}

function setVisionOptionControlsEnabled(enabled) {
  ['visionMaxTokens', 'visionContextMode', 'visionMultiImageMode', 'visionContextMaxChars'].forEach(key => {
    const el = document.getElementById(`enhancement-${key}`);
    if (el) el.disabled = !enabled;
  });
}

function setVisionBatchSizeEnabled(enabled) {
  const el = document.getElementById('enhancement-visionBatchSize');
  if (el) el.disabled = !enabled;
}

function setRetryConfigControlsEnabled(enabled) {
  ['retryMaxRetries', 'retryBaseMs', 'retryCapMs', 'retryTotalSeconds'].forEach(key => {
    const el = document.getElementById(`enhancement-${key}`);
    if (el) el.disabled = !enabled;
  });
}

function setSelfHealControlsEnabled(enabled) {
  ['signature', 'budget', 'media'].forEach(key => {
    const el = document.getElementById(`enhancement-selfHeal-${key}`);
    if (el) el.disabled = !enabled;
  });
}

function updateEnhancementNumber(input, key) {
  ensureModelMapDefaults();
  if (!Object.prototype.hasOwnProperty.call(DEFAULT_PROXY_ENHANCEMENT, key)) return;
  const min = key === 'visionMaxTokens' ? 64
    : key === 'visionContextMaxChars' ? 500
      : (key === 'retryMaxRetries' || key === 'rateLimitRpm') ? 0 : 1;
  const value = normalizeEnhancementInt(input.value, DEFAULT_PROXY_ENHANCEMENT[key], min);
  modelMapStore.enhancement[key] = value;
  input.value = value;
  autoSaveEnhancement();
}

function updateVisionMultiImageMode(select) {
  updateEnhancementSelect(select, 'visionMultiImageMode');
  setVisionBatchSizeEnabled(select.value === 'chunk' && modelMapStore.enhancement.imageFallback !== false);
}

globalThis._enhancementSaveTimer = null;
async function autoSaveEnhancement() {
  ensureModelMapDefaults();
  if (_enhancementSaveTimer) clearTimeout(_enhancementSaveTimer);
  _enhancementSaveTimer = setTimeout(async () => {
    _enhancementSaveTimer = null;
    if (await persistModelMap()) {
      if (typeof syncProxyEnhancementSummary === 'function') syncProxyEnhancementSummary();
    } else if (lastSavedProxyEnhancement) {
      modelMapStore.enhancement = cloneProxyEnhancement(lastSavedProxyEnhancement);
      renderProxyEnhancement();
      if (typeof syncProxyEnhancementSummary === 'function') syncProxyEnhancementSummary();
    }
  }, 400);
}

async function saveProxyEnhancement() {
  ensureModelMapDefaults();
  if (_enhancementSaveTimer) { clearTimeout(_enhancementSaveTimer); _enhancementSaveTimer = null; }
  if (await persistModelMap()) {
    addLog('ok', '已保存代理增强配置');
    await renderModelMap();
    if (typeof syncProxyEnhancementSummary === 'function') syncProxyEnhancementSummary();
    const modal = document.getElementById('proxyEnhancementModal');
    if (modal?.classList.contains('editor-overlay')) closeProxyEnhancement();
  } else if (lastSavedProxyEnhancement) {
    modelMapStore.enhancement = cloneProxyEnhancement(lastSavedProxyEnhancement);
    renderProxyEnhancement();
    if (typeof syncProxyEnhancementSummary === 'function') syncProxyEnhancementSummary();
  }
}

function resetProxyEnhancementDefaults() {
  ensureModelMapDefaults();
  modelMapStore.enhancement = defaultProxyEnhancement();
  renderProxyEnhancement();
  autoSaveEnhancement();
}

function renderProxyVisionModelList() {
  ensureModelMapDefaults();
  const wrap = document.getElementById('proxyVisionModelList');
  if (!wrap) return;
  const items = modelMapStore.visionModels.imageModels;
  if (!items.length) {
    wrap.innerHTML = '<div style="padding:14px;border:1px dashed var(--border);border-radius:9px;color:var(--text-muted);font-size:12px;text-align:center;">尚未配置图片理解模型。添加后可在映射列表启用第三方图片理解。</div>';
    return;
  }
  wrap.innerHTML = items.map((item, idx) => {
    const p = (providerStore.providers || []).find(x => x.id === item.providerId);
    const invalid = !p || p.enabled === false;
    const caps = p ? providerCapabilities(p, item.model || p.defaultModel || null) : null;
    const capText = caps?.vision === true ? '已知支持图片' : '未确认图片能力';
    const capColor = caps?.vision === true ? 'var(--success)' : 'var(--text-muted)';
    const key = visionModelKey(item.providerId, item.model, item.apiFormat);
    const testing = proxyVisionTestingKey === key;
    return `
      <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px 12px;border:1px solid ${invalid ? 'rgba(217,119,6,.28)' : 'var(--border)'};border-radius:9px;background:var(--bg-card);">
        <div style="display:flex;align-items:center;gap:10px;min-width:0;flex:1;">
          <span style="width:22px;height:22px;border-radius:6px;background:var(--bg-input);color:var(--text-muted);font-size:11px;font-weight:800;display:inline-flex;align-items:center;justify-content:center;flex-shrink:0;">${idx + 1}</span>
          <div style="display:flex;flex-direction:column;gap:3px;min-width:0;">
            <strong style="font-size:12px;color:${invalid ? 'var(--warn,#d97706)' : 'var(--text-primary)'};overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escAttr(visionModelLabel(item))}</strong>
            <span style="font-size:10px;color:${capColor};">${invalid ? '供应商不可用' : capText}</span>
          </div>
        </div>
        <div style="display:flex;align-items:center;gap:6px;flex-shrink:0;">
          <button class="btn-ghost" data-action="moveVisionModel" data-args="[${idx},-1]" ${idx === 0 ? 'disabled' : ''} style="height:26px;padding:0 8px;border-radius:7px;font-size:11px;">↑</button>
          <button class="btn-ghost" data-action="moveVisionModel" data-args="[${idx},1]" ${idx === items.length - 1 ? 'disabled' : ''} style="height:26px;padding:0 8px;border-radius:7px;font-size:11px;">↓</button>
          <button id="vision-test-btn-${idx}" class="btn-ghost" data-action="testVisionModel" data-args="[${idx}]" ${testing ? 'disabled' : ''} style="height:26px;padding:0 9px;border-radius:7px;font-size:11px;">${testing ? '测试中...' : '测试'}</button>
          <button class="btn-ghost" data-action="removeVisionModel" data-args="[${idx}]" style="height:26px;padding:0 8px;border-radius:7px;font-size:11px;">✕</button>
        </div>
      </div>`;
  }).join('');
}

function toggleVisionModelPicker() {
  setVisionModelPickerOpen(!proxyVisionPickerOpen);
}

function closeVisionModelPicker() {
  setVisionModelPickerOpen(false);
}

function setVisionModelPickerOpen(open) {
  proxyVisionPickerOpen = open === true;
  const picker = document.getElementById('proxyVisionModelPicker');
  if (picker) {
    picker.classList.toggle('is-open', proxyVisionPickerOpen);
    picker.setAttribute('aria-hidden', proxyVisionPickerOpen ? 'false' : 'true');
  }
  if (proxyVisionPickerOpen) {
    proxyVisionProviderSearch = '';
    proxyVisionPickedModels = new Map();
    const search = document.getElementById('proxyVisionModelSearch');
    if (search) search.value = '';
    const providers = visionModelProviderEntries();
    if (!providers.some(provider => provider.providerId === proxyVisionSelectedProviderId)) {
      proxyVisionSelectedProviderId = providers[0]?.providerId || '';
    }
    if (search) setTimeout(() => search.focus(), 0);
  }
  renderVisionModelPicker();
}

function collectVisionModelOptions() {
  const options = [];
  (providerStore.providers || []).forEach(p => {
    if (!p || p.enabled === false || p.meta?.codexConfig === true) return;
    providerSelectedModels(p).forEach(model => {
      const caps = providerCapabilities(p, model);
      ['openai', 'anthropic'].forEach(apiFormat => {
        options.push({ providerId: p.id, providerName: p.name || p.id, model, apiFormat, vision: caps.vision === true });
      });
    });
  });
  return options.sort((a, b) => Number(b.vision) - Number(a.vision) || a.providerName.localeCompare(b.providerName) || a.model.localeCompare(b.model));
}

function visionFormatLabel(apiFormat) {
  return normalizeMappingApiFormat(apiFormat) === 'anthropic' ? 'Anthropic' : 'OpenAI';
}

function visionOptionKey(option) {
  return visionModelKey(option.providerId, option.model, option.apiFormat);
}

function visionModelIcon(modelId) {
  if (typeof renderModelIcon === 'function') return renderModelIcon(modelId);
  const initial = String(modelId || '?').trim().charAt(0).toUpperCase() || '?';
  return `<div class="model-item-icon fallback">${escAttr(initial)}</div>`;
}

function visionModelProviderEntries() {
  const groups = new Map();
  collectVisionModelOptions().forEach(option => {
    if (!groups.has(option.providerId)) {
      groups.set(option.providerId, {
        providerId: option.providerId,
        providerName: option.providerName || option.providerId,
        models: [],
      });
    }
    groups.get(option.providerId).models.push(option);
  });
  return Array.from(groups.values()).sort((a, b) => a.providerName.localeCompare(b.providerName) || a.providerId.localeCompare(b.providerId));
}

function visionProviderSearchHaystack(provider) {
  return [
    provider?.providerName,
    provider?.providerId,
    ...(provider?.models || []).flatMap(model => [model.model, model.apiFormat, visionFormatLabel(model.apiFormat)]),
  ].map(x => String(x || '').toLowerCase()).join(' ');
}

function visibleVisionModelProviders() {
  const terms = String(proxyVisionProviderSearch || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
  const list = visionModelProviderEntries();
  if (!terms.length) return list;
  return list.filter(provider => {
    const haystack = visionProviderSearchHaystack(provider);
    return terms.every(term => haystack.includes(term));
  });
}

function visionModelProviderEntry(providerId) {
  return visionModelProviderEntries().find(provider => provider.providerId === providerId) || null;
}

function totalPickedVisionModelCount() {
  let total = 0;
  proxyVisionPickedModels.forEach(bucket => { total += bucket.size; });
  return total;
}

function currentVisionProviderPickedCount() {
  return proxyVisionPickedModels.get(proxyVisionSelectedProviderId)?.size || 0;
}

function onVisionModelPickerSearch() {
  proxyVisionProviderSearch = document.getElementById('proxyVisionModelSearch')?.value || '';
  const providers = visibleVisionModelProviders();
  if (!providers.some(provider => provider.providerId === proxyVisionSelectedProviderId)) {
    proxyVisionSelectedProviderId = providers[0]?.providerId || '';
  }
  renderVisionModelPicker();
}

function selectVisionModelProvider(providerId) {
  proxyVisionSelectedProviderId = String(providerId || '').trim();
  renderVisionModelPicker();
}

function toggleVisionModelOption(providerId, optionKey) {
  const provider = visionModelProviderEntry(providerId);
  const option = (provider?.models || []).find(item => visionOptionKey(item) === optionKey);
  if (!option) return;
  const configured = new Set(modelMapStore.visionModels.imageModels.map(x => visionModelKey(x.providerId, x.model, x.apiFormat)));
  if (configured.has(optionKey)) return;
  let bucket = proxyVisionPickedModels.get(providerId);
  if (!bucket) {
    bucket = new Set();
    proxyVisionPickedModels.set(providerId, bucket);
  }
  if (bucket.has(optionKey)) {
    bucket.delete(optionKey);
    if (!bucket.size) proxyVisionPickedModels.delete(providerId);
  } else {
    bucket.add(optionKey);
  }
  renderVisionModelPicker();
}

function selectAllVisionModels() {
  const provider = visionModelProviderEntry(proxyVisionSelectedProviderId);
  if (!provider) return;
  const configured = new Set(modelMapStore.visionModels.imageModels.map(x => visionModelKey(x.providerId, x.model, x.apiFormat)));
  const available = (provider.models || []).map(visionOptionKey).filter(key => !configured.has(key));
  if (!available.length) return;
  proxyVisionPickedModels.set(provider.providerId, new Set(available));
  renderVisionModelPicker();
}

function selectNoVisionModels() {
  proxyVisionPickedModels.delete(proxyVisionSelectedProviderId);
  renderVisionModelPicker();
}

function syncVisionModelPickerActions() {
  const provider = visionModelProviderEntry(proxyVisionSelectedProviderId);
  const configured = new Set(modelMapStore.visionModels.imageModels.map(x => visionModelKey(x.providerId, x.model, x.apiFormat)));
  const available = provider ? (provider.models || []).filter(option => !configured.has(visionOptionKey(option))) : [];
  const picked = totalPickedVisionModelCount();
  const currentPicked = currentVisionProviderPickedCount();
  const allBtn = document.getElementById('proxyVisionSelectAllBtn');
  const noneBtn = document.getElementById('proxyVisionSelectNoneBtn');
  const addBtn = document.getElementById('proxyVisionAddSelectedBtn');
  const summary = document.getElementById('proxyVisionPickedSummary');
  if (allBtn) allBtn.disabled = !available.length || currentPicked === available.length;
  if (noneBtn) noneBtn.disabled = currentPicked === 0;
  if (addBtn) addBtn.disabled = picked === 0;
  if (summary) summary.textContent = picked ? `已选择 ${picked} 个模型` : '未选择模型';
}

function renderVisionModelPicker() {
  const providerList = document.getElementById('proxyVisionProviderList');
  const modelList = document.getElementById('proxyVisionModelPickerList');
  const title = document.getElementById('proxyVisionModelProviderTitle');
  const sub = document.getElementById('proxyVisionModelProviderSub');
  if (!providerList || !modelList) return;
  ensureModelMapDefaults();
  const configured = new Set(modelMapStore.visionModels.imageModels.map(x => visionModelKey(x.providerId, x.model, x.apiFormat)));
  const providers = visibleVisionModelProviders();
  if (!providers.some(provider => provider.providerId === proxyVisionSelectedProviderId)) {
    proxyVisionSelectedProviderId = providers[0]?.providerId || '';
  }

  if (!providers.length) {
    providerList.innerHTML = `<div class="proxy-route-picker-empty">${visionModelProviderEntries().length ? '没有匹配的供应商或模型' : '暂无可用供应商'}</div>`;
  } else {
    providerList.innerHTML = providers.map(provider => {
      const active = provider.providerId === proxyVisionSelectedProviderId;
      const isLP = isLocalProxyProviderEntry(provider);
      return `
        <button type="button" class="proxy-route-provider-item ${active ? 'active' : ''} ${isLP ? 'is-local-proxy' : ''}" data-action="selectVisionModelProvider" data-arg="${escAttr(provider.providerId)}">
          <span class="proxy-route-provider-icon">${escAttr(String(provider.providerName || provider.providerId || '?').trim().charAt(0).toUpperCase() || '?')}</span>
          <span class="proxy-route-provider-name">${escAttr(provider.providerName || provider.providerId)}${isLP ? '<span class="proxy-route-prov-badge">本地代理</span>' : ''}</span>
          <span class="proxy-route-provider-count">${provider.models.length}</span>
        </button>
      `;
    }).join('');
  }

  const selectedProvider = visionModelProviderEntry(proxyVisionSelectedProviderId);
  if (!selectedProvider) {
    if (title) title.textContent = '请选择供应商';
    if (sub) sub.textContent = '右侧会展示可加入图片理解链的模型';
    modelList.innerHTML = '<div class="proxy-route-picker-empty">先从左侧选择供应商</div>';
    syncVisionModelPickerActions();
    return;
  }

  const pickedCount = currentVisionProviderPickedCount();
  if (title) title.textContent = selectedProvider.providerName || selectedProvider.providerId;
  if (sub) sub.textContent = `共 ${selectedProvider.models.length} 个模型，当前已选 ${pickedCount} 个`;
  if (!selectedProvider.models.length) {
    modelList.innerHTML = '<div class="proxy-route-picker-empty">该供应商暂无可选模型</div>';
    syncVisionModelPickerActions();
    return;
  }

  const bucket = proxyVisionPickedModels.get(selectedProvider.providerId) || new Set();
  modelList.innerHTML = selectedProvider.models.map(option => {
    const key = visionOptionKey(option);
    const already = configured.has(key);
    const active = already || bucket.has(key);
    return `
      <button type="button" class="proxy-route-model-item proxy-vision-model-item ${active ? 'active' : ''} ${already ? 'is-disabled' : ''}"
        ${already ? 'disabled' : ''} data-action="toggleVisionModelOption" data-args="[&quot;${escAttr(selectedProvider.providerId)}&quot;,&quot;${escAttr(key)}&quot;]">
        <span class="proxy-route-model-check">${active ? '&#10003;' : ''}</span>
        ${visionModelIcon(option.model)}
        <span class="proxy-route-model-name">
          <strong>${escAttr(option.model)}</strong>
          <small>${escAttr(visionFormatLabel(option.apiFormat))} · ${option.vision ? '已知支持图片' : '未确认图片能力'}</small>
        </span>
      </button>`;
  }).join('');
  syncVisionModelPickerActions();
}

async function addSelectedVisionModels() {
  ensureModelMapDefaults();
  const prev = modelMapStore.visionModels.imageModels.slice();
  const existing = new Set(modelMapStore.visionModels.imageModels.map(x => visionModelKey(x.providerId, x.model, x.apiFormat)));
  let added = 0;
  proxyVisionPickedModels.forEach(bucket => {
    bucket.forEach(key => {
      const decoded = decodeVisionModelKey(key);
      const providerId = decoded.providerId || '';
      const model = decoded.model || '';
      const apiFormat = normalizeMappingApiFormat(decoded.apiFormat) || 'openai';
      if (providerId && model && !existing.has(key)) {
        modelMapStore.visionModels.imageModels.push({ providerId, model, apiFormat });
        existing.add(key);
        added += 1;
      }
    });
  });
  if (!added) return;
  proxyVisionPickedModels = new Map();
  closeVisionModelPicker();
  renderProxyEnhancement();
  if (await persistModelMap()) {
    addLog('ok', `已保存 ${added} 个图片理解模型`);
    if (typeof syncProxyEnhancementSummary === 'function') syncProxyEnhancementSummary();
  } else {
    modelMapStore.visionModels.imageModels = prev;
    renderProxyEnhancement();
  }
}

async function removeVisionModel(idx) {
  ensureModelMapDefaults();
  const prev = modelMapStore.visionModels.imageModels.slice();
  modelMapStore.visionModels.imageModels.splice(idx, 1);
  renderProxyEnhancement();
  if (await persistModelMap()) {
    addLog('info', '已删除图片理解模型');
    if (typeof syncProxyEnhancementSummary === 'function') syncProxyEnhancementSummary();
  } else {
    modelMapStore.visionModels.imageModels = prev;
    renderProxyEnhancement();
  }
}

async function moveVisionModel(idx, dir) {
  ensureModelMapDefaults();
  const list = modelMapStore.visionModels.imageModels;
  const next = idx + dir;
  if (next < 0 || next >= list.length) return;
  const prev = list.slice();
  const tmp = list[idx];
  list[idx] = list[next];
  list[next] = tmp;
  renderProxyEnhancement();
  if (await persistModelMap()) {
    addLog('info', '已保存图片理解模型顺序');
    if (typeof syncProxyEnhancementSummary === 'function') syncProxyEnhancementSummary();
  } else {
    modelMapStore.visionModels.imageModels = prev;
    renderProxyEnhancement();
  }
}

globalThis.SEARCH_SOURCE_PRESETS = Object.freeze([
  { key: 'tavily', type: 'api', label: 'Tavily', needsKey: true, defaultHost: 'https://api.tavily.com' },
  { key: 'serper', type: 'api', label: 'Serper', needsKey: true, defaultHost: 'https://google.serper.dev' },
  { key: 'bravesearch', type: 'api', label: 'Brave Search', needsKey: true, defaultHost: 'https://api.search.brave.com' },
  { key: 'duckduckgo', type: 'engine', label: 'DuckDuckGo', needsKey: false, defaultHost: '' },
  { key: 'searxng', type: 'engine', label: 'SearXNG', needsKey: false, defaultHost: '' },
]);

function searchSourceDisplayName(key) {
  const preset = SEARCH_SOURCE_PRESETS.find(x => x.key === String(key || '').toLowerCase());
  return preset?.label || String(key || 'Search');
}

function searchSourcePreset(key) {
  return SEARCH_SOURCE_PRESETS.find(x => x.key === String(key || '').toLowerCase()) || null;
}

function searchSourceKey(src) {
  return String(src?.engine || src?.provider || '').trim().toLowerCase();
}

function renderProxySearchSourceList() {
  ensureModelMapDefaults();
  const wrap = document.getElementById('proxySearchSourceList');
  if (!wrap) return;
  const items = modelMapStore.searchModels.searchSources;
  if (!items.length) {
    wrap.innerHTML = '<div style="padding:14px;border:1px dashed var(--border);border-radius:9px;color:var(--text-muted);font-size:12px;text-align:center;">尚未配置搜索源。目标模型无内置搜索时，需要至少一个启用的搜索源。</div>';
    return;
  }
  wrap.innerHTML = items.map((src, idx) => {
    const key = searchSourceKey(src);
    const preset = searchSourcePreset(key);
    const needsKey = preset?.needsKey === true;
    const isEngine = src.type === 'engine';
    const testing = proxySearchTestingId === src.id;
    return `
      <div style="display:flex;flex-direction:column;gap:9px;padding:12px;border:1px solid var(--border);border-radius:10px;background:var(--bg-card);">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;">
          <div style="display:flex;align-items:center;gap:9px;min-width:0;">
            <span style="width:24px;height:24px;border-radius:7px;background:var(--bg-input);color:var(--text-muted);font-size:11px;font-weight:800;display:inline-flex;align-items:center;justify-content:center;">${idx + 1}</span>
            <div style="display:flex;flex-direction:column;gap:2px;min-width:0;">
              <strong style="font-size:12px;color:var(--text-primary);">${escAttr(src.name || searchSourceDisplayName(key))}</strong>
              <small style="font-size:10px;color:var(--text-muted);">${isEngine ? '搜索引擎' : '搜索 API'} · ${escAttr(key)}</small>
            </div>
          </div>
          <label class="toggle-switch" title="启用搜索源">
            <input type="checkbox" ${src.enabled !== false ? 'checked' : ''} data-action="toggleSearchSourceEnabled" data-events="change" data-args="[${idx}]" data-pass-checked>
            <span class="toggle-slider"></span>
          </label>
        </div>
        <div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;">
          <label style="display:flex;flex-direction:column;gap:5px;font-size:10px;color:var(--text-muted);">
            API Key
            <input type="password" value="${escAttr(src.apiKey || '')}" ${needsKey ? '' : 'disabled'} placeholder="${needsKey ? '必填' : '无需 API Key'}" data-action="updateSearchSourceField" data-events="change" data-args="[${idx},&quot;apiKey&quot;]" data-pass-value style="height:30px;padding:0 9px;border-radius:8px;border:1px solid var(--border);background:var(--bg-input);color:var(--text-primary);">
          </label>
          <label style="display:flex;flex-direction:column;gap:5px;font-size:10px;color:var(--text-muted);">
            API Host
            <input type="text" value="${escAttr(src.apiHost || '')}" placeholder="${escAttr(preset?.defaultHost || (key === 'searxng' ? 'https://your-searxng.example.com' : '默认'))}" ${key === 'duckduckgo' ? 'disabled' : ''} data-action="updateSearchSourceField" data-events="change" data-args="[${idx},&quot;apiHost&quot;]" data-pass-value style="height:30px;padding:0 9px;border-radius:8px;border:1px solid var(--border);background:var(--bg-input);color:var(--text-primary);">
          </label>
        </div>
        <div style="display:flex;align-items:center;justify-content:flex-end;gap:6px;">
          <button class="btn-ghost" data-action="moveSearchSource" data-args="[${idx},-1]" ${idx === 0 ? 'disabled' : ''} style="height:26px;padding:0 8px;border-radius:7px;font-size:11px;">↑</button>
          <button class="btn-ghost" data-action="moveSearchSource" data-args="[${idx},1]" ${idx === items.length - 1 ? 'disabled' : ''} style="height:26px;padding:0 8px;border-radius:7px;font-size:11px;">↓</button>
          <button class="btn-ghost" data-action="testSearchSource" data-args="[${idx}]" ${testing ? 'disabled' : ''} style="height:26px;padding:0 9px;border-radius:7px;font-size:11px;">${testing ? '测试中...' : '测试'}</button>
          <button class="btn-ghost" data-action="removeSearchSource" data-args="[${idx}]" style="height:26px;padding:0 8px;border-radius:7px;font-size:11px;">删除</button>
        </div>
      </div>`;
  }).join('');
}

function toggleSearchSourcePicker() {
  proxySearchSourcePickerOpen = !proxySearchSourcePickerOpen;
  renderSearchSourcePicker();
}

function closeSearchSourcePicker() {
  proxySearchSourcePickerOpen = false;
  renderSearchSourcePicker();
}

function renderSearchSourcePicker() {
  const wrap = document.getElementById('proxySearchSourcePicker');
  if (!wrap) return;
  wrap.style.display = proxySearchSourcePickerOpen ? 'block' : 'none';
  if (!proxySearchSourcePickerOpen) {
    wrap.innerHTML = '';
    return;
  }
  wrap.innerHTML = `
    <div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;margin-top:10px;">
      ${SEARCH_SOURCE_PRESETS.map(preset => `
        <button type="button" class="btn-ghost" data-action="addSearchSource" data-arg="${escAttr(preset.key)}" style="text-align:left;padding:10px;border-radius:9px;border:1px solid var(--border);background:var(--bg-card);display:flex;flex-direction:column;gap:3px;">
          <strong style="font-size:12px;color:var(--text-primary);">${escAttr(preset.label)}</strong>
          <small style="font-size:10px;color:var(--text-muted);">${preset.type === 'api' ? 'API' : 'Engine'} · ${preset.needsKey ? '需要 Key' : '无需 Key'}</small>
        </button>`).join('')}
    </div>`;
}

async function addSearchSource(key) {
  ensureModelMapDefaults();
  const preset = searchSourcePreset(key);
  if (!preset) return;
  const prev = modelMapStore.searchModels.searchSources.slice();
  modelMapStore.searchModels.searchSources.push({
    id: `src-${preset.key}-${Date.now().toString(36)}`,
    name: preset.label,
    type: preset.type,
    provider: preset.type === 'api' ? preset.key : '',
    engine: preset.type === 'engine' ? preset.key : '',
    apiKey: '',
    apiHost: preset.defaultHost,
    enabled: true,
  });
  closeSearchSourcePicker();
  renderProxyEnhancement();
  if (!(await persistModelMap())) {
    modelMapStore.searchModels.searchSources = prev;
    renderProxyEnhancement();
  }
}

async function updateSearchSourceField(idx, field, value) {
  ensureModelMapDefaults();
  const src = modelMapStore.searchModels.searchSources[idx];
  if (!src || !['apiKey', 'apiHost'].includes(field)) return;
  src[field] = String(value || '').trim();
  await persistModelMap();
}

async function toggleSearchSourceEnabled(idx, enabled) {
  ensureModelMapDefaults();
  const src = modelMapStore.searchModels.searchSources[idx];
  if (!src) return;
  src.enabled = enabled === true;
  await persistModelMap();
}

async function removeSearchSource(idx) {
  ensureModelMapDefaults();
  const prev = modelMapStore.searchModels.searchSources.slice();
  modelMapStore.searchModels.searchSources.splice(idx, 1);
  renderProxyEnhancement();
  if (!(await persistModelMap())) {
    modelMapStore.searchModels.searchSources = prev;
    renderProxyEnhancement();
  }
}

async function moveSearchSource(idx, dir) {
  ensureModelMapDefaults();
  const list = modelMapStore.searchModels.searchSources;
  const next = idx + dir;
  if (next < 0 || next >= list.length) return;
  const prev = list.slice();
  [list[idx], list[next]] = [list[next], list[idx]];
  renderProxyEnhancement();
  if (!(await persistModelMap())) {
    modelMapStore.searchModels.searchSources = prev;
    renderProxyEnhancement();
  }
}

async function testSearchSource(idx) {
  ensureModelMapDefaults();
  const src = modelMapStore.searchModels.searchSources[idx];
  if (!src) return;
  const query = await showCustomPrompt('输入测试搜索关键词', '今日新闻', '搜索测试');
  if (!query) return;
  proxySearchTestingId = src.id;
  renderProxyEnhancement();
  try {
    const runtime = typeof getLocalProxyRuntimeConfig === 'function' ? getLocalProxyRuntimeConfig('codex') : null;
    const port = typeof getLocalProxyPort === 'function' ? getLocalProxyPort() : 7450;
    const res = await fetch(`http://127.0.0.1:${port}/__byok/web-search/test`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(runtime?.apiKey ? { authorization: `Bearer ${runtime.apiKey}` } : {}) },
      body: JSON.stringify({ source: src, query, maxResults: 3 }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    const count = Array.isArray(data.results) ? data.results.length : 0;
    showCustomAlert((data.results || []).map((r, i) => `${i + 1}. ${r.title}\n${r.url}\n${r.snippet || ''}`).join('\n\n') || '没有结果', `搜索测试成功 (${count})`, 'success');
  } catch (e) {
    showCustomAlert(String(e?.message || e), '搜索测试失败', 'error');
  } finally {
    proxySearchTestingId = '';
    renderProxyEnhancement();
  }
}

function isMissingVisionTestCommandMessage(msg) {
  const lower = String(msg || '').toLowerCase();
  return lower.includes('unknown command') || lower.includes('command not found');
}

function closeVisionTestModal() {
  document.getElementById('proxyVisionTestModal')?.classList.remove('active');
}

function setVisionTestState(state, meta, result) {
  const modalEl = document.querySelector('#proxyVisionTestModal .proxy-vision-test-modal');
  const statusEl = document.getElementById('proxyVisionTestStatus');
  const metaEl = document.getElementById('proxyVisionTestMeta');
  const resultEl = document.getElementById('proxyVisionTestResult');
  const statusText = state === 'success' ? '测试通过' : (state === 'error' ? '测试失败' : '测试中');
  if (modalEl) modalEl.dataset.state = state;
  if (statusEl) {
    statusEl.className = `proxy-vision-test-status is-${state}`;
    statusEl.textContent = statusText;
  }
  if (metaEl) metaEl.textContent = meta || '';
  if (resultEl) {
    resultEl.className = `proxy-vision-test-result is-${state}`;
    resultEl.textContent = result || '';
    resultEl.scrollTop = 0;
  }
}

async function testVisionModel(idx) {
  ensureModelMapDefaults();
  const item = modelMapStore.visionModels.imageModels[idx];
  if (!item) return;
  const key = visionModelKey(item.providerId, item.model, item.apiFormat);
  proxyVisionTestingKey = key;
  const modal = document.getElementById('proxyVisionTestModal');
  const image = document.getElementById('proxyVisionTestImage');
  const title = document.getElementById('proxyVisionTestTitle');
  const imageBase64 = await getProxyVisionTestImageBase64();
  if (modal) modal.classList.add('active');
  if (image) image.src = `data:image/png;base64,${imageBase64}`;
  if (title) title.textContent = `图片测试 · ${visionModelLabel(item)}`;
  setVisionTestState('running', '正在发送测试图片...', '等待供应商返回图片理解结果。');
  renderProxyVisionModelList();
  const started = Date.now();
  try {
    const res = await invoke('test_vision', {
      args: { providerId: item.providerId, model: item.model, apiFormat: item.apiFormat, imageBase64 }
    });
    const duration = res?.durationMs ?? (Date.now() - started);
    if (res?.ok === false) {
      const err = res.error || '模型未返回有效图片理解结果';
      const message = isMissingVisionTestCommandMessage(err) ? '图片测试接口待实现，请重启应用加载新版后端。' : err;
      setVisionTestState('error', `失败 · ${duration}ms`, message);
    } else {
      const text = String(res?.text || '测试成功').slice(0, 1200);
      setVisionTestState('success', `成功 · ${duration}ms`, text);
    }
  } catch (e) {
    const msg = String(e || '');
    if (isMissingVisionTestCommandMessage(msg)) {
      setVisionTestState('error', '失败', '图片测试接口待实现，请重启应用加载新版后端。');
    } else {
      setVisionTestState('error', '失败', msg);
    }
  } finally {
    proxyVisionTestingKey = '';
    renderProxyVisionModelList();
  }
}

async function toggleSlotThirdPartyVision(uid, enabled) {
  ensureModelMapDefaults();
  const s = modelMapStore.slots.find(x => x.modelUid === uid);
  if (!s) return;
  const prev = s.useThirdPartyVision === true;
  s.useThirdPartyVision = enabled === true;
  if (await persistModelMap()) {
    addLog('ok', `已${enabled ? '启用' : '停用'}「${s.displayName || uid}」的第三方图片理解`);
    await renderModelMap();
  } else {
    s.useThirdPartyVision = prev;
    await renderModelMap();
  }
}
// ─── 模型映射显示设置模态框（名称前缀 + 后缀 + 高级模板）───
// 跟 sidecar renderTemplate 保持一致:占位符 {prefix} {label} {provider} {apiModel}
// 模板含 {provider} 且 provider 空 → 「未设置」
globalThis.DEFAULT_LABEL_TEMPLATE = '{prefix} {label} ({provider})';
globalThis.SIMPLE_LABEL_TEMPLATE_BASE = '{prefix} {label}';
globalThis.TEMPLATE_VAR_NAMES = ['prefix', 'label', 'provider', 'apiModel'];
globalThis.labelTemplateModalMode = 'simple';

function renderLabelTemplate(tpl, vars) {
  const tmpl = (tpl && tpl.trim()) || DEFAULT_LABEL_TEMPLATE;
  const hasProvider = /\bprovider\b/.test(tmpl);
  const v = {
    prefix: vars.prefix || '',
    label: vars.label || '',
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
// modelMapStore.injected: [{ label, modelUid, providerId, model, apiFormat, unlock, supportsImages }]
// 加载时确保存在（兼容旧 model-map.json）
globalThis.injectedCatalog = null;     // 128 模型内置目录（首次调用时加载）
globalThis.slotVisibilityRows = [];
globalThis.slotVisibilityDirty = false;

globalThis.UNLOCK_SCOPE_LABELS = {
  all: '全部槽位',
  common: '常用槽位',
  claude: 'Claude',
  gpt: 'GPT / Codex',
  gemini: 'Gemini',
  code: 'Code / SWE',
  configured: '已配置 BYOK',
};

globalThis.SLOT_VISIBILITY_LABELS = {
  mapped: '应用：仅显示已映射槽位',
  official: '应用：已映射 + 官方模型',
  all: '应用：已映射 + 官方模型 + 全部',
};

globalThis.SLOT_VISIBILITY_SHORT_LABELS = {
  mapped: '仅已映射',
  official: '已映射 + 官方',
  all: '全部模型',
};

function normalizeUnlockScope(mode) {
  return Object.prototype.hasOwnProperty.call(UNLOCK_SCOPE_LABELS, mode) ? mode : 'all';
}

function normalizeSlotVisibilityMode(mode) {
  return Object.prototype.hasOwnProperty.call(SLOT_VISIBILITY_LABELS, mode) ? mode : 'official';
}

function ensureSlotVisibilityArray() {
  if (!Array.isArray(modelMapStore.slotVisibility)) modelMapStore.slotVisibility = [];
  return modelMapStore.slotVisibility;
}

function slotVisibilityOverrideMap() {
  const map = new Map();
  ensureSlotVisibilityArray().forEach(item => {
    if (item && item.modelUid) map.set(item.modelUid, item.visible !== false);
  });
  return map;
}

function baseSlotVisibleForMode(row, mode) {
  const normalized = normalizeSlotVisibilityMode(mode);
  if (row.isMapped) return true;
  if (row.isOfficial) return normalized === 'official' || normalized === 'all';
  return normalized === 'all';
}

function updateSlotPresetButtons(rows = slotVisibilityRows) {
  const allRows = Array.isArray(rows) ? rows : [];
  const counts = {
    mapped: allRows.filter(row => baseSlotVisibleForMode(row, 'mapped')).length,
    official: allRows.filter(row => baseSlotVisibleForMode(row, 'official')).length,
    all: allRows.length,
  };
  const activeMode = normalizeSlotVisibilityMode(modelMapStore.slotVisibilityMode);
  document.querySelectorAll('.model-slot-preset').forEach(btn => {
    const mode = normalizeSlotVisibilityMode(btn.dataset.mode);
    let labelEl = btn.querySelector('.model-slot-preset-label');
    let countEl = btn.querySelector('.model-slot-preset-count');
    if (!labelEl || !countEl) {
      btn.textContent = '';
      labelEl = document.createElement('span');
      labelEl.className = 'model-slot-preset-label';
      countEl = document.createElement('span');
      countEl.className = 'model-slot-preset-count';
      btn.append(labelEl, countEl);
    }
    const label = btn.dataset.label || SLOT_VISIBILITY_LABELS[mode] || mode;
    const count = counts[mode] || 0;
    labelEl.textContent = label;
    countEl.textContent = String(count);
    btn.classList.toggle('active', mode === activeMode);
    btn.setAttribute('aria-pressed', mode === activeMode ? 'true' : 'false');
    btn.title = `${label}：${count} 个槽位`;
  });
}

function updateSlotFilterCounts(rows = slotVisibilityRows) {
  const filterEl = document.getElementById('injected-filter');
  if (!filterEl) return;
  const allRows = Array.isArray(rows) ? rows : [];
  const counts = {
    all: allRows.length,
    visible: allRows.filter(row => row.visible).length,
    hidden: allRows.filter(row => !row.visible).length,
    mapped: allRows.filter(row => row.isMapped).length,
    official: allRows.filter(row => row.isOfficial).length,
    unconfigured: allRows.filter(row => !row.isMapped && !row.isOfficial && !row.hasConfiguredByok).length,
  };
  const labels = {
    all: '全部',
    visible: '显示中',
    hidden: '已隐藏',
    mapped: '已映射',
    official: '官方模型',
    unconfigured: '未配置',
  };
  Array.from(filterEl.options).forEach(option => {
    const value = option.value;
    if (!Object.prototype.hasOwnProperty.call(labels, value)) return;
    option.textContent = `${labels[value]} (${counts[value] || 0})`;
  });
}

function setSlotVisibilityFilter(value) {
  const filter = document.getElementById('injected-filter');
  if (filter) filter.value = value;
}

function setSlotVisibilityDirty(dirty) {
  slotVisibilityDirty = !!dirty;
  const saveBtn = document.getElementById('slot-visibility-save-btn');
  const saveLabel = document.getElementById('slot-visibility-save-label');
  if (saveBtn) saveBtn.classList.toggle('has-pending', slotVisibilityDirty);
  if (saveLabel) saveLabel.textContent = slotVisibilityDirty ? '保存更改' : '保存';
  updateSlotPolicySummary();
}

function updateSlotPolicySummary() {
  const summary = document.getElementById('slot-policy-summary');
  if (!summary) return;
  const visibility = normalizeSlotVisibilityMode(modelMapStore.slotVisibilityMode);
  const rows = slotVisibilityRows || [];
  const visibleCount = rows.filter(r => r.visible).length;
  const overrideCount = ensureSlotVisibilityArray().length;
  const shortLabel = SLOT_VISIBILITY_SHORT_LABELS[visibility] || SLOT_VISIBILITY_SHORT_LABELS.official;
  summary.textContent = [
    `当前策略：${shortLabel}`,
    rows.length ? `已显示 ${visibleCount} / ${rows.length}` : '',
    overrideCount ? `单独调整 ${overrideCount}` : '',
    slotVisibilityDirty ? '未保存' : '',
  ].filter(Boolean).join(' · ');
}

async function setSlotVisibilityMode(mode) {
  const nextMode = normalizeSlotVisibilityMode(mode);
  const hadOverrides = ensureSlotVisibilityArray().length > 0;
  const changed = normalizeSlotVisibilityMode(modelMapStore.slotVisibilityMode) !== nextMode || hadOverrides;
  modelMapStore.slotVisibilityMode = nextMode;
  modelMapStore.slotVisibility = [];
  modelMapStore.unlockScope = 'all';
  modelMapStore.slotDisplayMode = 'all';
  // 预设按钮表示最终 IDE 模型列表策略；应用后直接展示策略命中的槽位。
  setSlotVisibilityFilter('visible');
  if (changed) setSlotVisibilityDirty(true);
  updateSlotPresetButtons();
  // 点击 flash 动画：让按钮短暂闪烁表示已应用
  const clickedBtn = document.querySelector(`.model-slot-preset[data-mode="${nextMode}"]`);
  if (clickedBtn) {
    clickedBtn.classList.add('just-applied');
    setTimeout(() => clickedBtn.classList.remove('just-applied'), 600);
  }
  await renderInjectedList();
  const shortLabel = SLOT_VISIBILITY_SHORT_LABELS[nextMode] || nextMode;
  addLog('info', `策略「${shortLabel}」已应用，共 ${slotVisibilityRows.filter(r => r.visible).length} 个槽位显示，保存后生效`);
}

function setSlotVisibilityOverride(uid, visible) {
  if (!uid) return;
  modelMapStore.slotVisibility = ensureSlotVisibilityArray().filter(item => item && item.modelUid !== uid);
  const row = (slotVisibilityRows || []).find(item => item.uid === uid);
  if (row && row.baseVisible === !!visible) return;
  modelMapStore.slotVisibility.push({ modelUid: uid, visible: !!visible });
}

function onSlotVisibilityToggle(uid, checked) {
  setSlotVisibilityOverride(uid, checked);
  setSlotVisibilityDirty(true);
  renderInjectedList();
}

function toggleSlotVisibilitySelectAll(checked) {
  document.querySelectorAll('.slot-visibility-row-check').forEach(input => {
    const row = input.closest('tr');
    if (!row || row.style.display === 'none') return;
    input.checked = !!checked;
  });
  syncSlotVisibilitySelectionState();
}

function selectedSlotVisibilityUids() {
  return Array.from(document.querySelectorAll('.slot-visibility-row-check:checked'))
    .map(input => input.dataset.uid)
    .filter(Boolean);
}

function syncSlotVisibilitySelectionState() {
  const checks = Array.from(document.querySelectorAll('.slot-visibility-row-check'));
  const selected = checks.filter(input => input.checked).length;
  const selectAll = document.getElementById('slot-visibility-select-all');
  if (selectAll) {
    selectAll.checked = checks.length > 0 && selected === checks.length;
    selectAll.indeterminate = selected > 0 && selected < checks.length;
  }
  const label = document.getElementById('slot-visibility-select-label');
  if (label) label.textContent = selected ? `已选 ${selected}` : '选择';
  const disabled = selected === 0;
  const enableBtn = document.getElementById('slot-bulk-enable-btn');
  const disableBtn = document.getElementById('slot-bulk-disable-btn');
  if (enableBtn) enableBtn.disabled = disabled;
  if (disableBtn) disableBtn.disabled = disabled;
}

function batchSetSlotVisibility(visible) {
  const uids = selectedSlotVisibilityUids();
  if (uids.length === 0) {
    showCustomAlert('请先勾选要批量调整的模型槽位', '未选择槽位', 'info');
    return;
  }
  uids.forEach(uid => setSlotVisibilityOverride(uid, visible));
  setSlotVisibilityDirty(true);
  renderInjectedList();
  addLog('info', `已${visible ? '启用' : '禁用'} ${uids.length} 个模型槽位，保存后生效`);
}

function modelSlotSkeletonHtml(rows = 9) {
  const body = Array.from({ length: rows }, (_, idx) => `
    <div class="model-slot-skeleton-row" aria-hidden="true">
      <span class="model-slot-skeleton-check" style="--delay:${idx * 45}ms"></span>
      <span class="model-slot-skeleton-line name" style="--delay:${idx * 45 + 40}ms"></span>
      <span class="model-slot-skeleton-line uid" style="--delay:${idx * 45 + 80}ms"></span>
      <span class="model-slot-skeleton-line provider" style="--delay:${idx * 45 + 120}ms"></span>
      <span class="model-slot-skeleton-check" style="--delay:${idx * 45 + 160}ms"></span>
    </div>`).join('');
  return `
    <div class="model-slot-skeleton" role="status" aria-label="正在加载模型槽位目录">
      <div class="model-slot-skeleton-header">
        <span></span>
        <span>模型名</span>
        <span>modelUid</span>
        <span>状态</span>
        <span>显示</span>
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
  const page = document.getElementById('page-model-slots');
  if (!page) return;
  navigateTo('model-slots');
  try {
    const res = await invoke('load_model_map');
    if (res && Array.isArray(res.slots)) modelMapStore = res;
  } catch (e) {
    addLog('warn', '加载模型槽位配置失败: ' + e);
  }
  // 确保 modelMapStore.injected 存在
  if (!Array.isArray(modelMapStore.injected)) modelMapStore.injected = [];
  const list = document.getElementById('injected-list');
  if (list) {
    list.innerHTML = modelSlotSkeletonHtml();
  }
  await syncCurrentIdeModels();
  document.getElementById('injected-search').value = '';
  document.getElementById('injected-filter').value = 'all';
  modelMapStore.unlockScope = normalizeUnlockScope(modelMapStore.unlockScope || modelMapStore.slotDisplayMode);
  modelMapStore.slotDisplayMode = modelMapStore.unlockScope;
  modelMapStore.slotVisibilityMode = normalizeSlotVisibilityMode(modelMapStore.slotVisibilityMode);
  ensureSlotVisibilityArray();
  slotVisibilityDirty = false;
  updateSlotPresetButtons();
  setSlotVisibilityDirty(false);
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
  navigateTo('models');
}

function buildSlotVisibilityRows() {
  const rows = new Map();
  const ensureRow = (uid, label, apiId = '', source = 'catalog') => {
    if (!uid) return null;
    const existing = rows.get(uid) || {
      uid,
      label: label || uid,
      apiId: apiId || '',
      isMapped: false,
      isOfficial: false,
      hasConfiguredByok: false,
      source,
    };
    if (label && (!existing.label || existing.label === existing.uid)) existing.label = label;
    if (apiId && !existing.apiId) existing.apiId = apiId;
    if (source === 'account') existing.source = 'account';
    rows.set(uid, existing);
    return existing;
  };

  (ideModels || []).forEach(m => {
    const row = ensureRow(m.id, m.name, m.api_id || '', isAccountSlotModel(m) ? 'account' : 'extended');
    if (row && isAccountSlotModel(m)) row.isOfficial = true;
  });
  (injectedCatalog || []).forEach(m => {
    ensureRow(m.modelUid, m.label, m.apiId || '', 'catalog');
  });
  (modelMapStore.injected || []).forEach(i => {
    const row = ensureRow(i.modelUid, i.label, i.model || '', 'catalog');
    if (row) row.hasConfiguredByok = !!(i.providerId && String(i.model || '').trim());
  });
  (modelMapStore.slots || []).forEach(s => {
    const fallback = originalNameOf(s.modelUid);
    const row = ensureRow(s.modelUid, s.displayName || fallback, '', 'mapped');
    if (!row) return;
    row.isMapped = true;
    row.label = s.displayName || row.label || fallback;
    row.mappingEnabled = s.enabled !== false;
  });

  const overrides = slotVisibilityOverrideMap();
  const mode = normalizeSlotVisibilityMode(modelMapStore.slotVisibilityMode);
  const statusOf = row => {
    if (row.isMapped) return row.mappingEnabled === false ? 'mapped-off' : 'mapped';
    if (row.isOfficial) return 'official';
    if (row.hasConfiguredByok) return 'configured';
    return 'unconfigured';
  };

  return Array.from(rows.values()).map(row => {
    const baseVisible = baseSlotVisibleForMode(row, mode);
    const hasOverride = overrides.has(row.uid);
    return {
      ...row,
      originalName: originalNameOf(row.uid),
      baseVisible,
      visible: hasOverride ? overrides.get(row.uid) : baseVisible,
      hasOverride,
      status: statusOf(row),
    };
  }).sort((a, b) => {
    const rank = row => row.isMapped ? 0 : (row.isOfficial ? 1 : 2);
    return rank(a) - rank(b) || a.label.localeCompare(b.label);
  });
}

function renderSlotStatusPill(row) {
  const styles = {
    mapped: ['已映射', 'rgba(37,99,235,.10)', 'var(--accent)', 'rgba(37,99,235,.24)'],
    'mapped-off': ['已映射', 'var(--bg-input)', 'var(--text-muted)', 'var(--border)'],
    official: ['官方', 'rgba(22,163,74,.10)', 'var(--success,#16a34a)', 'rgba(22,163,74,.24)'],
    configured: ['已配置', 'rgba(13,148,136,.10)', 'var(--accent-secondary,#0d9488)', 'rgba(13,148,136,.24)'],
    unconfigured: ['未配置', 'rgba(217,119,6,.10)', 'var(--warn,#d97706)', 'rgba(217,119,6,.24)'],
  };
  const s = styles[row.status] || styles.unconfigured;
  return `<span class="tag" style="background:${s[1]};color:${s[2]};border:1px solid ${s[3]};font-size:10px;padding:2px 7px;border-radius:7px;font-weight:700;white-space:nowrap;">${s[0]}</span>`;
}

async function renderInjectedList() {
  const list = document.getElementById('injected-list');
  if (!list) return;
  await ensureInjected();
  const query = (document.getElementById('injected-search')?.value || '').toLowerCase().trim();
  const filter = document.getElementById('injected-filter')?.value || 'all';
  slotVisibilityRows = buildSlotVisibilityRows();
  updateSlotPresetButtons(slotVisibilityRows);
  updateSlotFilterCounts(slotVisibilityRows);

  const rows = slotVisibilityRows.filter(row => {
    if (filter === 'visible' && !row.visible) return false;
    if (filter === 'hidden' && row.visible) return false;
    if (filter === 'mapped' && !row.isMapped) return false;
    if (filter === 'official' && !row.isOfficial) return false;
    if (filter === 'unconfigured' && (row.isMapped || row.isOfficial || row.hasConfiguredByok)) return false;
    if (!query) return true;
    const hay = `${row.label || ''} ${row.uid || ''} ${row.apiId || ''}`.toLowerCase();
    return hay.includes(query);
  });

  updateSlotPolicySummary();
  const selectAll = document.getElementById('slot-visibility-select-all');
  if (selectAll) {
    selectAll.checked = false;
    selectAll.indeterminate = false;
  }
  const badge = document.getElementById('injected-count-badge');
  if (badge) badge.textContent = '模型槽位管理';

  if (rows.length === 0) {
    list.innerHTML = '<div style="padding:28px;text-align:center;color:var(--text-muted);font-size:12px;">无匹配模型槽位</div>';
    syncSlotVisibilitySelectionState();
    return;
  }

  list.innerHTML = `<table class="slot-visibility-table">
    <thead>
      <tr>
        <th style="width:34px;"></th>
        <th>模型名</th>
        <th>原始模型名</th>
        <th>modelUid</th>
        <th style="width:120px;">状态</th>
        <th style="width:96px;text-align:right;">显示</th>
      </tr>
    </thead>
    <tbody>
      ${rows.map(row => `
        <tr data-uid="${escAttr(row.uid)}" class="${row.visible ? '' : 'is-hidden'}">
          <td>
            <input class="slot-visibility-row-check" data-uid="${escAttr(row.uid)}" type="checkbox" data-action="syncSlotVisibilitySelectionState" data-events="change">
          </td>
          <td>
            <div class="slot-visibility-name">${escAttr(row.label)}</div>
            ${row.apiId ? `<div class="slot-visibility-sub">${escAttr(row.apiId)}</div>` : ''}
          </td>
          <td class="slot-visibility-orig">${escAttr(row.originalName)}</td>
          <td class="slot-visibility-uid">${escAttr(row.uid)}</td>
          <td>
            <div class="slot-visibility-status">
              ${renderSlotStatusPill(row)}
              ${row.hasOverride ? '<span class="slot-visibility-override">单独设置</span>' : ''}
            </div>
          </td>
          <td>
            <label class="slot-visibility-switch" title="${row.visible ? '当前显示在 IDE 模型列表' : '当前不显示在 IDE 模型列表'}">
              <input type="checkbox" ${row.visible ? 'checked' : ''} data-action="onSlotVisibilityToggle" data-events="change" data-args="[&quot;${escAttr(row.uid)}&quot;]" data-pass-checked>
              <span></span>
            </label>
          </td>
      </tr>`).join('')}
    </tbody>
  </table>`;
  syncSlotVisibilitySelectionState();
}

async function saveInjectedFromEditor() {
  modelMapStore.unlockScope = 'all';
  modelMapStore.slotDisplayMode = 'all';
  modelMapStore.slotVisibilityMode = normalizeSlotVisibilityMode(modelMapStore.slotVisibilityMode);
  ensureSlotVisibilityArray();
  if (await persistModelMap()) {
    setSlotVisibilityDirty(false);
    addLog('ok', '已保存模型槽位显示设置');
    await renderInjectedList();
    await renderModelMap();
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
    else {
      s.enabled = !s.enabled;
      await renderModelMap();
    }
  } finally {
    _inFlightToggles.delete(key);
  }
}

async function deleteSlot(uid) {
  const previous = cloneModelMapStore();
  modelMapStore.slots = modelMapStore.slots.filter(x => x.modelUid !== uid);
  if (await persistModelMap()) {
    await renderModelMap();
    addLog('info', '已删除映射');
  } else {
    modelMapStore = cloneModelMapStore(previous);
    await renderModelMap();
  }
}

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
  return '自动';
}

function unlockKindForSlotUid(uid) {
  const provider = String(slotModelOf(uid)?.provider || '').trim().toLowerCase();
  if (provider === 'openai') return 'codex';
  if (provider === 'anthropic') return 'claudeCode';
  return '';
}

function preferredRouteForSlotTarget(slotUid, providerId) {
  const preferredUnlock = unlockKindForSlotUid(slotUid);
  const p = (providerStore.providers || []).find(x => x.id === providerId);
  if (preferredUnlock && mappingProviderUnlockEnabled(p, preferredUnlock)) return preferredUnlock;
  if (preferredUnlock === 'codex') return 'openai';
  if (preferredUnlock === 'claudeCode') return 'anthropic';
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

function targetWithSlotRoute(target, slotUid) {
  const providerId = String(target?.providerId || '').trim();
  const model = String(target?.model || '').trim();
  const out = { providerId, model };
  applyRouteToTarget(out, targetRouteValue(target, slotUid));
  const apiPath = String(target?.apiPath || target?.api_path || '').trim();
  if (apiPath) out.apiPath = apiPath;
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
  (providerStore.providers || []).forEach(p => {
    if (p.enabled !== false && p.meta?.codexConfig !== true && !isLocalProxyProvider(p)) {
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

  // 渲染供应商快速筛选栏
  const providerBar = document.getElementById('mappingCatalogProviderBar');
  const providerIds = [...new Set(allModels.map(m => m.providerId))];
  if (providerBar) {
    if (providerIds.length > 1) {
      const providerNames = {};
      allModels.forEach(m => { providerNames[m.providerId] = m.providerName; });
      providerBar.innerHTML = `
        <button data-set="mappingCatalogProvider" data-set-value="" data-action="renderMappingModelCatalog" style="height:22px;padding:0 8px;border-radius:6px;border:1px solid ${!mappingCatalogProvider ? 'var(--accent)' : 'var(--border)'};background:${!mappingCatalogProvider ? 'var(--accent-light)' : 'transparent'};color:${!mappingCatalogProvider ? 'var(--accent)' : 'var(--text-muted)'};font-size:10px;font-weight:700;cursor:pointer;">全部 ${allModels.length}</button>
        ${providerIds.map(pid => `
          <button data-set="mappingCatalogProvider" data-set-value="${escAttr(pid)}" data-action="renderMappingModelCatalog" style="height:22px;padding:0 8px;border-radius:6px;border:1px solid ${mappingCatalogProvider === pid ? 'var(--accent)' : 'var(--border)'};background:${mappingCatalogProvider === pid ? 'var(--accent-light)' : 'transparent'};color:${mappingCatalogProvider === pid ? 'var(--accent)' : 'var(--text-muted)'};font-size:10px;font-weight:700;cursor:pointer;">${escAttr(providerNames[pid] || pid)} ${allModels.filter(m => m.providerId === pid).length}</button>
        `).join('')}
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

    const logoChar = item.providerName.charAt(0).toUpperCase();
    const logoClass = getProviderLogoClass(item.providerName);

    return `
      <div class="mapping-catalog-item ${isSelected ? 'selected' : ''}"
           data-action="toggleMappingModelTarget" data-args="[&quot;${escAttr(item.providerId)}&quot;,&quot;${escAttr(item.model)}&quot;]"
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
        <button data-set="slotCatalogBrand" data-set-value="" data-action="renderSlotCatalogList" style="height:22px;padding:0 8px;border-radius:6px;border:1px solid ${!slotCatalogBrand ? 'var(--accent)' : 'var(--border)'};background:${!slotCatalogBrand ? 'var(--accent-light)' : 'transparent'};color:${!slotCatalogBrand ? 'var(--accent)' : 'var(--text-muted)'};font-size:10px;font-weight:700;cursor:pointer;">全部</button>
        ${availableBrands.map(b => `
          <button data-set="slotCatalogBrand" data-set-value="${b.id}" data-action="renderSlotCatalogList" style="height:22px;padding:0 8px;border-radius:6px;border:1px solid ${slotCatalogBrand === b.id ? 'var(--accent)' : 'var(--border)'};background:${slotCatalogBrand === b.id ? 'var(--accent-light)' : 'transparent'};color:${slotCatalogBrand === b.id ? 'var(--accent)' : 'var(--text-muted)'};font-size:10px;font-weight:700;cursor:pointer;">${b.label}</button>
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
        : '需要先通过代理抓取 Windsurf 下拉清单，或点击刷新读取当前 IDE 账号模型。';
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
    const takenTag = taken ? `<span class="brand-tag" style="background:var(--bg-secondary); color:var(--text-muted); border: 1px solid var(--border); padding: 1px 6px; font-size: 9px; font-weight:normal;">已绑定</span>` : '';
    const displayId = m.api_id || m.id;
    const visionTag = renderVisionPill(nativeVisionSlotInfo(m.id), true);
    const sourceTag = renderSourcePill(slotSourceInfo(m), true);
    const recommended = !taken && slotRecommendationRank(m, used) < 0;
    const recommendedTag = recommended ? `<span class="brand-tag" style="background:rgba(37,99,235,.10);color:var(--accent);border:1px solid rgba(37,99,235,.22);padding:1px 6px;font-size:9px;font-weight:700;">推荐</span>` : '';

    // 选中态的对号放在左侧图标区（替换魔方），保持右侧 tag 队列结构稳定、所有卡片右对齐
    const leftIcon = isSelected
      ? `<div style="width:24px; height:24px; border-radius:6px; background:var(--accent); color:#fff; display:flex; align-items:center; justify-content:center; flex-shrink:0; transition:all 0.2s; font-size:14px; font-weight:800; line-height:1;">✓</div>`
      : `<div style="width:24px; height:24px; border-radius:6px; background:${taken ? 'var(--bg-secondary)' : 'var(--bg-secondary)'}; color:${taken ? 'var(--text-muted)' : 'var(--text-secondary)'}; display:flex; align-items:center; justify-content:center; flex-shrink:0; transition:all 0.2s;">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"></path><polyline points="3.27 6.96 12 12.01 20.73 6.96"></polyline><line x1="12" y1="22.08" x2="12" y2="12"></line></svg>
          </div>`;

    // 渲染具有极致质感的左侧行卡片，支持选中态发光与锁定态置灰
    return `
      <div class="slot-catalog-item ${isSelected ? 'selected' : ''} ${taken ? 'taken' : ''}"
           ${taken ? '' : `data-action="selectCatalogSlot" data-args="[&quot;${escAttr(m.id)}&quot;,&quot;${escAttr(m.name)}&quot;]"`}
           style="display:flex; align-items:center; justify-content:space-between; padding:12px 16px; border:1px solid ${isSelected ? 'var(--accent)' : 'var(--border)'}; background:${isSelected ? 'var(--accent-light)' : 'var(--bg-card)'}; opacity:${taken ? '0.5' : '1'}; cursor:${taken ? 'not-allowed' : 'pointer'}; border-radius:10px; gap:12px; transition:all 0.2s; box-shadow:${isSelected ? '0 0 12px var(--accent-glow)' : 'none'};">
        <div style="display:flex; align-items:center; gap:10px; flex:1; min-width:0;">
          ${leftIcon}
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

async function openSlotEditor(uid) {
  await syncCurrentIdeModels();
  await ensureInjected();
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

async function saveSlotFromEditor() {
  const editUid = document.getElementById('slot-edit-uid').value;
  const selectedUid = document.getElementById('slot-uid-select').value;
  const uid = selectedUid || editUid;
  const display = document.getElementById('slot-display').value.trim();
  const contextWindow = readSlotContextWindowInput();
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
      s.targets = targetsWithSlotRoute(selectedMappingTargets, uid);
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
      targets: targetsWithSlotRoute(selectedMappingTargets, uid)
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
    const routeValue = targetRouteValue(row, failoverEditUid);
    const routeOpts = targetRouteOptionsForProvider(cur, routeValue).map(opt =>
      `<option value="${escAttr(opt.value)}"${opt.value === routeValue ? ' selected' : ''}>${escAttr(opt.label)}</option>`
    ).join('');

    return `
      <div style="display:flex;flex-direction:column;gap:6px" data-fo-idx="${i}">
        <div style="display:flex;gap:8px;align-items:center">
          <span style="width:20px;text-align:center;color:var(--text-muted)">${marks[i] || (i + 1)}</span>
          <select class="input-sm" style="flex:1" data-action="updateFailoverRow" data-events="change" data-args="[${i},&quot;providerId&quot;]" data-pass-value>${invalidOpt}${provOpts}</select>
          <select class="input-sm" style="flex:0 0 132px" data-action="updateFailoverRow" data-events="change" data-args="[${i},&quot;route&quot;]" data-pass-value>${routeOpts}</select>
          <select class="input-sm" style="flex:1; text-align: left;" data-action="updateFailoverRow" data-events="change" data-args="[${i},&quot;model&quot;]" data-pass-value>
            <option value=""${!row.model ? ' selected' : ''}>默认模型</option>
            ${modelOpts}
            <option value="__custom__">+ 输入自定义模型...</option>
          </select>
          <button class="btn-ghost" title="上移" data-action="moveFailoverRow" data-args="[${i},-1]" ${i === 0 ? 'disabled' : ''}>↑</button>
          <button class="btn-ghost" title="下移" data-action="moveFailoverRow" data-args="[${i},1]" ${i === failoverDraft.length - 1 ? 'disabled' : ''}>↓</button>
          <button class="btn-ghost" title="删除" data-action="removeFailoverRow" data-args="[${i}]">✕</button>
        </div>
        ${capLine}
      </div>`;
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

// ---- P3 globalThis mirror (functions/classes) ----
(function mirrorFns(g) {
  g.defaultProxyEnhancement = defaultProxyEnhancement;
  g.cloneModelMapStore = cloneModelMapStore;
  g.cloneProxyEnhancement = cloneProxyEnhancement;
  g.normalizeHeaderPair = normalizeHeaderPair;
  g.sanitizeHeaderPairsForPersist = sanitizeHeaderPairsForPersist;
  g.modelMapForPersist = modelMapForPersist;
  g.getProxyVisionTestImageBase64 = getProxyVisionTestImageBase64;
  g.ensureModelMapDefaults = ensureModelMapDefaults;
  g.normalizeEnhancementInt = normalizeEnhancementInt;
  g.visionModelKey = visionModelKey;
  g.decodeVisionModelKey = decodeVisionModelKey;
  g.visionModelLabel = visionModelLabel;
  g.ensureIdeModels = ensureIdeModels;
  g.refreshIdeModels = refreshIdeModels;
  g.syncCurrentIdeModels = syncCurrentIdeModels;
  g.originalNameOf = originalNameOf;
  g.detectModelBrand = detectModelBrand;
  g.getAvailableBrands = getAvailableBrands;
  g.renderTargetChain = renderTargetChain;
  g.renderModelMap = renderModelMap;
  g.startEditDisplayName = startEditDisplayName;
  g.filterModelTable = filterModelTable;
  g.persistModelMap = persistModelMap;
  g.cleanupModelMapSelection = cleanupModelMapSelection;
  g.toggleModelMapSelection = toggleModelMapSelection;
  g.visibleModelMapSlots = visibleModelMapSlots;
  g.toggleVisibleModelMapSelectionFromHeader = toggleVisibleModelMapSelectionFromHeader;
  g.toggleVisibleModelMapSelection = toggleVisibleModelMapSelection;
  g.syncModelMapSelectionState = syncModelMapSelectionState;
  g.batchSetSelectedSlotsEnabled = batchSetSelectedSlotsEnabled;
  g.batchSetSelectedSlotsThirdPartyVision = batchSetSelectedSlotsThirdPartyVision;
  g.batchDeleteSelectedSlots = batchDeleteSelectedSlots;
  g.renderProxyEnhancement = renderProxyEnhancement;
  g.renderHeaderList = renderHeaderList;
  g.addHeaderPair = addHeaderPair;
  g.updateHeaderPair = updateHeaderPair;
  g.removeHeaderPair = removeHeaderPair;
  g.updateEnhancementText = updateEnhancementText;
  g.updateEnhancementSelect = updateEnhancementSelect;
  g.updateParamOverrides = updateParamOverrides;
  g.updateToolFilterList = updateToolFilterList;
  g.openProxyEnhancement = openProxyEnhancement;
  g.closeProxyEnhancement = closeProxyEnhancement;
  g.toggleEnhancement = toggleEnhancement;
  g.toggleSelfHeal = toggleSelfHeal;
  g.setPanelControlsEnabled = setPanelControlsEnabled;
  g.setVisionOptionControlsEnabled = setVisionOptionControlsEnabled;
  g.setVisionBatchSizeEnabled = setVisionBatchSizeEnabled;
  g.setRetryConfigControlsEnabled = setRetryConfigControlsEnabled;
  g.setSelfHealControlsEnabled = setSelfHealControlsEnabled;
  g.updateEnhancementNumber = updateEnhancementNumber;
  g.updateVisionMultiImageMode = updateVisionMultiImageMode;
  g.autoSaveEnhancement = autoSaveEnhancement;
  g.saveProxyEnhancement = saveProxyEnhancement;
  g.resetProxyEnhancementDefaults = resetProxyEnhancementDefaults;
  g.renderProxyVisionModelList = renderProxyVisionModelList;
  g.toggleVisionModelPicker = toggleVisionModelPicker;
  g.closeVisionModelPicker = closeVisionModelPicker;
  g.setVisionModelPickerOpen = setVisionModelPickerOpen;
  g.collectVisionModelOptions = collectVisionModelOptions;
  g.visionFormatLabel = visionFormatLabel;
  g.visionOptionKey = visionOptionKey;
  g.visionModelIcon = visionModelIcon;
  g.visionModelProviderEntries = visionModelProviderEntries;
  g.visionProviderSearchHaystack = visionProviderSearchHaystack;
  g.visibleVisionModelProviders = visibleVisionModelProviders;
  g.visionModelProviderEntry = visionModelProviderEntry;
  g.totalPickedVisionModelCount = totalPickedVisionModelCount;
  g.currentVisionProviderPickedCount = currentVisionProviderPickedCount;
  g.onVisionModelPickerSearch = onVisionModelPickerSearch;
  g.selectVisionModelProvider = selectVisionModelProvider;
  g.toggleVisionModelOption = toggleVisionModelOption;
  g.selectAllVisionModels = selectAllVisionModels;
  g.selectNoVisionModels = selectNoVisionModels;
  g.syncVisionModelPickerActions = syncVisionModelPickerActions;
  g.renderVisionModelPicker = renderVisionModelPicker;
  g.addSelectedVisionModels = addSelectedVisionModels;
  g.removeVisionModel = removeVisionModel;
  g.moveVisionModel = moveVisionModel;
  g.searchSourceDisplayName = searchSourceDisplayName;
  g.searchSourcePreset = searchSourcePreset;
  g.searchSourceKey = searchSourceKey;
  g.renderProxySearchSourceList = renderProxySearchSourceList;
  g.toggleSearchSourcePicker = toggleSearchSourcePicker;
  g.closeSearchSourcePicker = closeSearchSourcePicker;
  g.renderSearchSourcePicker = renderSearchSourcePicker;
  g.addSearchSource = addSearchSource;
  g.updateSearchSourceField = updateSearchSourceField;
  g.toggleSearchSourceEnabled = toggleSearchSourceEnabled;
  g.removeSearchSource = removeSearchSource;
  g.moveSearchSource = moveSearchSource;
  g.testSearchSource = testSearchSource;
  g.isMissingVisionTestCommandMessage = isMissingVisionTestCommandMessage;
  g.closeVisionTestModal = closeVisionTestModal;
  g.setVisionTestState = setVisionTestState;
  g.testVisionModel = testVisionModel;
  g.toggleSlotThirdPartyVision = toggleSlotThirdPartyVision;
  g.renderLabelTemplate = renderLabelTemplate;
  g.normalizedLabelTemplate = normalizedLabelTemplate;
  g.composeSimpleLabelTemplate = composeSimpleLabelTemplate;
  g.suffixFromSimpleLabelTemplate = suffixFromSimpleLabelTemplate;
  g.currentModalLabelTemplate = currentModalLabelTemplate;
  g.labelTemplateForStoreFromModal = labelTemplateForStoreFromModal;
  g.providerNameOf = providerNameOf;
  g.openModelMapSettings = openModelMapSettings;
  g.closeModelMapSettings = closeModelMapSettings;
  g.onModalSimpleLabelInput = onModalSimpleLabelInput;
  g.onModalAdvancedLabelTemplateInput = onModalAdvancedLabelTemplateInput;
  g.onLabelTemplateAdvancedToggle = onLabelTemplateAdvancedToggle;
  g.onModalLabelTemplateInput = onModalLabelTemplateInput;
  g.updateModalLabelTemplatePreview = updateModalLabelTemplatePreview;
  g.saveModelMapSettingsFromModal = saveModelMapSettingsFromModal;
  g.normalizeUnlockScope = normalizeUnlockScope;
  g.normalizeSlotVisibilityMode = normalizeSlotVisibilityMode;
  g.ensureSlotVisibilityArray = ensureSlotVisibilityArray;
  g.slotVisibilityOverrideMap = slotVisibilityOverrideMap;
  g.baseSlotVisibleForMode = baseSlotVisibleForMode;
  g.updateSlotPresetButtons = updateSlotPresetButtons;
  g.updateSlotFilterCounts = updateSlotFilterCounts;
  g.setSlotVisibilityFilter = setSlotVisibilityFilter;
  g.setSlotVisibilityDirty = setSlotVisibilityDirty;
  g.updateSlotPolicySummary = updateSlotPolicySummary;
  g.setSlotVisibilityMode = setSlotVisibilityMode;
  g.setSlotVisibilityOverride = setSlotVisibilityOverride;
  g.onSlotVisibilityToggle = onSlotVisibilityToggle;
  g.toggleSlotVisibilitySelectAll = toggleSlotVisibilitySelectAll;
  g.selectedSlotVisibilityUids = selectedSlotVisibilityUids;
  g.syncSlotVisibilitySelectionState = syncSlotVisibilitySelectionState;
  g.batchSetSlotVisibility = batchSetSlotVisibility;
  g.modelSlotSkeletonHtml = modelSlotSkeletonHtml;
  g.ensureInjected = ensureInjected;
  g.openInjectedEditor = openInjectedEditor;
  g.closeInjectedEditor = closeInjectedEditor;
  g.buildSlotVisibilityRows = buildSlotVisibilityRows;
  g.renderSlotStatusPill = renderSlotStatusPill;
  g.renderInjectedList = renderInjectedList;
  g.saveInjectedFromEditor = saveInjectedFromEditor;
  g.toggleSlotEnabled = toggleSlotEnabled;
  g.deleteSlot = deleteSlot;
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
  g.openSlotEditor = openSlotEditor;
  g.closeSlotEditor = closeSlotEditor;
  g.setSlotContextPreset = setSlotContextPreset;
  g.applyRecommendedSlotContextWindow = applyRecommendedSlotContextWindow;
  g.refreshSlotContextRecommendHint = refreshSlotContextRecommendHint;
  g.saveSlotFromEditor = saveSlotFromEditor;
  g.enabledProviders = enabledProviders;
  g.routeLabelForValue = routeLabelForValue;
  g.targetRouteOptionsForProvider = targetRouteOptionsForProvider;
  g.openFailoverEditor = openFailoverEditor;
  g.closeFailoverEditor = closeFailoverEditor;
  g.renderFailoverRows = renderFailoverRows;
  g.addFailoverRow = addFailoverRow;
  g.updateFailoverRow = updateFailoverRow;
  g.moveFailoverRow = moveFailoverRow;
  g.removeFailoverRow = removeFailoverRow;
  g.saveFailoverFromEditor = saveFailoverFromEditor;
})(globalThis);
