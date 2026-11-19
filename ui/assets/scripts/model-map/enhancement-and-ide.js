// model-map/enhancement-and-ide.js — 网关增强默认配置、模型映射加载与 IDE 模型目录同步
import { escapeHtml, escAttr } from '../ui/dom.js';

// ═══════ MODEL MAP (可编辑槽位映射 + 故障转移链) ═══════
globalThis.modelMapStore = { slots: [] };       // load_model_map 结果
globalThis.modelMapLoaded = false;              // 是否已成功从磁盘载入
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
  failoverTtfbSeconds: 120,
  cooldownEnabled: true,
  cooldownTransientSeconds: 60,
  cooldownMaxSeconds: 600,
  cooldownAuthSeconds: 600,
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
  // 内置模型"模型 ID 批量重命名"规则(由网关 tab → 模型列表列头齿轮按钮设置)
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
    failoverTtfbSeconds: normalizeEnhancementInt(cur.failoverTtfbSeconds, DEFAULT_PROXY_ENHANCEMENT.failoverTtfbSeconds, 1),
    cooldownEnabled: cur.cooldownEnabled !== false,
    cooldownTransientSeconds: normalizeEnhancementInt(cur.cooldownTransientSeconds, DEFAULT_PROXY_ENHANCEMENT.cooldownTransientSeconds, 0),
    cooldownMaxSeconds: normalizeEnhancementInt(cur.cooldownMaxSeconds, DEFAULT_PROXY_ENHANCEMENT.cooldownMaxSeconds, 1),
    cooldownAuthSeconds: normalizeEnhancementInt(cur.cooldownAuthSeconds, DEFAULT_PROXY_ENHANCEMENT.cooldownAuthSeconds, 0),
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
function formatIdeModelsCapturedAt(ts) {
  if (ts == null || ts === '') return '';
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return '';
  // list_ide_models may return seconds or milliseconds
  const ms = n < 1e12 ? n * 1000 : n;
  try {
    return new Date(ms).toLocaleString();
  } catch {
    return '';
  }
}

function ideModelsSourcePresentation(source) {
  const key = String(source || '').trim().toLowerCase();
  if (key === 'captured') {
    return {
      key: 'captured',
      label: 'proxy capture',
      badgeBg: 'rgba(16,185,129,.12)',
      badgeColor: 'var(--ok, #059669)',
      badgeBorder: 'rgba(16,185,129,.28)',
      warn: false,
      title: '网关拦截的 GetUserStatus 清单，最接近 IDE 实际下拉框',
      hint: '当前清单来自网关实时抓取，与 IDE 模型下拉框更一致。',
    };
  }
  if (key === 'api') {
    return {
      key: 'api',
      label: 'api',
      badgeBg: 'rgba(245,158,11,.12)',
      badgeColor: 'var(--warn, #d97706)',
      badgeBorder: 'rgba(245,158,11,.30)',
      warn: true,
      title: 'GetUserStatus API 缓存，不一定等于 IDE 实际下拉框',
      hint: '清单来源为 api，不一定等于 IDE 实际下拉框。若模型不可见，请启动网关后重启 IDE 并打开一次模型选择器。',
    };
  }
  if (key === 'builtin') {
    return {
      key: 'builtin',
      label: 'builtin',
      badgeBg: 'var(--bg-input)',
      badgeColor: 'var(--text-muted)',
      badgeBorder: 'var(--border)',
      warn: true,
      title: '内置静态表，不一定等于 IDE 实际下拉框',
      hint: '清单来源为 builtin（内置静态表），不一定等于 IDE 实际下拉框。可点「刷新」拉取账号模型，或启动网关后重启 IDE 并打开一次模型选择器。',
    };
  }
  if (key) {
    return {
      key,
      label: key,
      badgeBg: 'rgba(245,158,11,.12)',
      badgeColor: 'var(--warn, #d97706)',
      badgeBorder: 'rgba(245,158,11,.30)',
      warn: true,
      title: `清单来源：${key}`,
      hint: `清单来源为 ${key}，不一定等于 IDE 实际下拉框。若模型不可见，请启动网关后重启 IDE 并打开一次模型选择器。`,
    };
  }
  return {
    key: '',
    label: '未知',
    badgeBg: 'var(--bg-input)',
    badgeColor: 'var(--text-muted)',
    badgeBorder: 'var(--border)',
    warn: true,
    title: '尚未获取清单来源',
    hint: '尚未获取清单来源。可点「刷新」或启动网关后抓取 IDE 实际下拉框。',
  };
}

function updateIdeModelsSourceUi() {
  // 来源徽标与清单提示横幅已移除，保持空函数以兼容调用
}

async function ensureIdeModels(options = {}) {
  const force = options === true || !!(options && options.force);
  if (ideModels && !force) {
    updateIdeModelsSourceUi();
    return ideModels;
  }
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
  updateIdeModelsSourceUi();
  return ideModels;
}

async function refreshIdeModels(options = {}) {
  const quiet = !!(options && options.quiet);
  const rerender = !(options && options.rerender === false);
  const btn = quiet ? null : document.getElementById('btn-refresh-models');
  try {
    if (btn) {
      if (typeof setLoading === 'function') setLoading(btn, '拉取中…');
      else btn.disabled = true;
    }
    const target = getTargetIde();
    const info = await invoke('refresh_ide_models', { target });
    const refreshed = await invoke('list_ide_models');
    if (refreshed && Array.isArray(refreshed.models)) {
      ideModels = refreshed.models;
      ideMeta = {
        source: refreshed.source || 'api',
        capturedAt: refreshed.captured_at || Date.now(),
        account: refreshed.account || {
          email: info.email,
          plan_name: info.plan_name,
          teams_tier: info.teams_tier,
          daily_remaining: info.daily_remaining,
          weekly_remaining: info.weekly_remaining,
          overage_balance_micros: info.overage_balance_micros,
        },
      };
    } else {
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
    }
    updateIdeModelsSourceUi();
    if (rerender) {
      maybeAutoSelectRecommendedSlot();
      renderSlotCatalogList();
      if (document.getElementById('page-model-slots')?.classList.contains('active')) {
        await renderInjectedList();
      }
    }
    if (!quiet) {
      const src = (ideMeta && ideMeta.source) || 'api';
      addLog('info', `模型列表已更新：${info.email} (${info.plan_name})，${info.models.length} 个模型，来源 ${src}`);
      if (src !== 'captured') {
        addLog('warn', `清单来源为 ${src}，不一定等于 IDE 实际下拉框；若模型不可见，请启动网关后重启 IDE 并打开一次模型选择器`);
      }
    }
    return true;
  } catch (e) {
    addLog(quiet ? 'warn' : 'error', `${quiet ? '自动同步当前账号模型列表失败' : '刷新模型列表失败'}: ${e}`);
    return false;
  } finally {
    if (btn) {
      if (typeof clearLoading === 'function') clearLoading(btn);
      else btn.disabled = false;
    }
  }
}

async function syncCurrentIdeModels(options = {}) {
  const ok = await refreshIdeModels({ quiet: true, rerender: false, ...(options || {}) });
  if (!ok) await ensureIdeModels({ force: true });
  else updateIdeModelsSourceUi();
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
    const effortText = String(t.thinkingEffort || t.thinking_effort || '').trim().toLowerCase();
    const effortBadge = effortText && effortText !== 'auto'
      ? `<span class="target-effort-badge" title="思考档位覆盖"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z"/></svg>${escAttr(effortText)}</span>` : '';
    const badges = p ? capabilityBadges(p, true, t.model || p.defaultModel || null) : '';
    const caps = badges || (invalid ? '<span class="target-cap-muted">供应商不可用</span>' : '<span class="target-cap-muted">未标记能力</span>');
    return `
      <div class="target-chain-item${invalid ? ' invalid' : ''}" title="${invalid ? '供应商不存在或未启用' : '配置故障转移分流目标'}">
        <div class="target-model-line">
          <span class="target-order">${i + 1}</span>
          <span class="target-model-text">${modelText}</span>
          <span class="target-cap-muted">${escAttr(routeText)}</span>
          ${effortBadge}
          ${invalid ? '<span class="target-warning">⚠</span>' : ''}
        </div>
        <div class="target-cap-line">${caps}</div>
      </div>`;
  }).join('')}</div>`;
}

// ---- P3 globalThis mirror ----
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
})(globalThis);
