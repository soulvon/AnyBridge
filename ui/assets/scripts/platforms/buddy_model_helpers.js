// platforms/buddy_model_helpers.js — Buddy/ZCode 上下文窗口推荐、能力药丸与模型勾选辅助

function cbRemoveAvailableModel(available, modelId) {
  const id = String(modelId || '').trim();
  return cbUniqueStrings(available).filter(item => item !== id);
}

function cbReplaceAvailableModel(available, oldId, newId) {
  const next = cbRemoveAvailableModel(available, oldId);
  return cbMergeAvailableModels(next, [{ id: newId }]);
}

function cbProviderChatUrl(provider) {
  return provider?.chatUrl || provider?.apiHost || provider?.api_host || '';
}

function zcNormalizeBaseUrl(value) {
  let base = String(value || '').trim().replace(/\/+$/g, '');
  base = base.replace(/\/(?:chat\/completions|responses)$/i, '').replace(/\/+$/g, '');
  return base;
}

function zcProviderBaseUrl(provider) {
  return zcNormalizeBaseUrl(cbProviderChatUrl(provider));
}

function zcHashId(value) {
  let hash = 0x811c9dc5;
  for (const ch of String(value || '')) {
    hash ^= ch.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function zcProviderIdNeedsMigration(providerId, model) {
  const id = String(providerId || '').trim();
  const key = String(model?.apiKey || '').trim();
  return !id || id === 'AnyBridge' || id.includes('://') || id.includes('/') || id.includes('\\') || (!!key && id.includes(key));
}

function zcProviderIdForModel(model) {
  const existing = String(model?.providerId || '').trim();
  if (existing && !zcProviderIdNeedsMigration(existing, model)) return existing;
  return `AnyBridge-${zcHashId(`${model?.vendor || 'Custom'}|${zcNormalizeBaseUrl(model?.url || '')}`)}`;
}

function zcProviderIdForProvider(provider) {
  return zcProviderIdForModel({
    vendor: provider?.providerName || 'Custom',
    url: zcProviderBaseUrl(provider),
    apiKey: cbProviderApiKey(provider),
  });
}

function zcProviderModelKeyParts(providerId, modelId) {
  const pid = String(providerId || '').trim();
  const mid = String(modelId || '').trim();
  return pid && mid ? JSON.stringify([pid, mid]) : '';
}

function zcProviderModelKey(model) {
  return zcProviderModelKeyParts(zcProviderIdForModel(model), model?.id);
}

function cbModelSelectionKey(prefix, model) {
  if (prefix === 'Zc') return zcProviderModelKey(model);
  return String(model?.id || '').trim();
}

function cbProviderApiKey(provider) {
  return provider?.apiKey || provider?.api_key || '';
}

function cbSelectedCapability(prefix, name) {
  const el = document.getElementById(`${prefix}-add-page-${name}`);
  return el ? !!el.checked : true;
}

/** 按模型 ID 推断推荐上下文窗口（token）。优先读 model-context-presets.json。 */
function cbRecommendContextWindow(modelId) {
  if (typeof globalThis.recommendContextWindow === 'function') {
    return globalThis.recommendContextWindow(modelId);
  }
  return 256000;
}

/** 按模型 ID 推断推荐最大输出 token。优先读 model-context-presets.json。 */
function cbRecommendMaxOutputTokens(modelId) {
  if (typeof globalThis.recommendMaxOutputTokens === 'function') {
    return globalThis.recommendMaxOutputTokens(modelId);
  }
  return 16384;
}

/** 是否为历史遗留的默认 128K 或 256K（可被更高推荐值覆盖） */
function cbIsLegacyDefaultContext(value) {
  const n = Number(value);
  return Number.isFinite(n) && (n === 128000 || n === 256000);
}

/**
 * 规范化模型上下文：缺失时填推荐值；
 * 若仍是历史默认值且推荐值更大，则升级到推荐值。
 * 用户手动改成的其他非默认值会保留。
 */
function cbNormalizeModelContext(model) {
  if (!model || typeof model !== 'object') return model;
  const id = model.id || '';
  const recommended = cbRecommendContextWindow(id);
  const recommendedOut = cbRecommendMaxOutputTokens(id);
  const current = model.maxInputTokens;
  if (current == null || current === '' || !Number.isFinite(Number(current)) || Number(current) <= 0) {
    model.maxInputTokens = recommended;
    if (model.maxOutputTokens == null) model.maxOutputTokens = recommendedOut;
    return model;
  }
  if (cbIsLegacyDefaultContext(current) && recommended > Number(current)) {
    model.maxInputTokens = recommended;
    if (model.maxOutputTokens == null || Number(model.maxOutputTokens) === 8192 || Number(model.maxOutputTokens) === 16384) {
      model.maxOutputTokens = recommendedOut;
    }
  }
  return model;
}

function cbNormalizeModelsContext(models) {
  if (!Array.isArray(models)) return [];
  return models.map((m) => cbNormalizeModelContext({ ...m }));
}

/** 格式化上下文 token 显示：128000 → 128K，1000000 → 1M */
function cbFormatContextTokens(value) {
  if (value == null || value === '') return '—';
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return '—';
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

function cbBuildModelEntry(provider, modelId, displayName, capabilities, platformId) {
  const isBuddy = platformId === CB_PLATFORM || platformId === WB_PLATFORM;
  const entry = {
    id: modelId,
    // Buddy UI 并排 name + id，name 只写供应商展示名（如 CPA）；ZCode 同样用供应商名。
    name: displayName || provider.providerName || (isBuddy ? (modelId || 'model') : 'Custom'),
    // 新版 Buddy 要求 vendor === "user" 才算自定义模型；ZCode 仍写供应商名用于分组。
    vendor: isBuddy ? 'user' : (provider.providerName || 'Custom'),
    url: platformId === ZC_PLATFORM ? zcProviderBaseUrl(provider) : cbProviderChatUrl(provider),
    apiKey: cbProviderApiKey(provider),
    maxInputTokens: cbRecommendContextWindow(modelId),
    maxOutputTokens: cbRecommendMaxOutputTokens(modelId),
    supportsToolCall: !!capabilities.supportsToolCall,
    supportsImages: !!capabilities.supportsImages,
    supportsReasoning: !!capabilities.supportsReasoning,
  };
  if (platformId === WB_PLATFORM) entry.useCustomProtocol = true;
  if (platformId === ZC_PLATFORM) entry.providerId = zcProviderIdForModel(entry);
  return entry;
}

function cbAddModelIdentity(modelId) {
  const id = String(modelId || '');
  const icon = typeof renderModelIcon === 'function'
    ? renderModelIcon(id)
    : `<div class="model-item-icon fallback">${platformEsc(id.charAt(0).toUpperCase() || '?')}</div>`;
  return `
    <div class="cb-add-model-line" title="${platformEsc(id)}">
      ${icon}
      <span class="cb-add-model-id">${platformEsc(id || '-')}</span>
    </div>
  `;
}

function cbOnAddModelCheckChanged(input, syncFn) {
  const row = input?.closest('.cb-add-model-row, .wb-add-model-row');
  if (row) {
    const exists = row.dataset.existing === 'true';
    row.classList.toggle('already-added', exists);
  }
  const fn = typeof syncFn === 'function' ? syncFn : (typeof syncFn === 'string' ? window[syncFn] : null);
  if (typeof fn === 'function') fn();
}

function cbSetAddModelChecks(selector, checked, syncFn) {
  document.querySelectorAll(selector).forEach((checkbox) => {
    checkbox.checked = checked;
    cbOnAddModelCheckChanged(checkbox);
  });
  if (typeof syncFn === 'function') syncFn();
}

function cbApplyProviderModelSelection(prefix, provider, checkSelector, platformId) {
  const ref = cbModelListRef(prefix);
  const currentModels = ref.getModels();
  const providerModels = Array.isArray(provider?.models) ? provider.models : [];
  const providerIds = new Set(providerModels.map(m => String(m?.id || '')).filter(Boolean));
  const isZcode = prefix === 'Zc' || platformId === ZC_PLATFORM;
  const zcodeProviderId = isZcode ? zcProviderIdForProvider(provider) : '';
  const isCurrentProviderModel = (model) => {
    const modelId = String(model?.id || '');
    if (!providerIds.has(modelId)) return false;
    if (!isZcode) return true;
    return zcProviderModelKey(model) === zcProviderModelKeyParts(zcodeProviderId, modelId);
  };
  const selectedIds = new Set(
    Array.from(document.querySelectorAll(`${checkSelector}:checked`))
      .map(chk => String(chk.dataset.modelId || '').trim())
      .filter(id => providerIds.has(id))
  );
  const capabilities = {
    supportsToolCall: cbSelectedCapability(ref.domPrefix, 'tools'),
    supportsImages: cbSelectedCapability(ref.domPrefix, 'images'),
    supportsReasoning: cbSelectedCapability(ref.domPrefix, 'reasoning'),
  };
  const previousSelectedCount = currentModels.filter(isCurrentProviderModel).length;
  const preservedModels = currentModels.filter(model => !isCurrentProviderModel(model));
  const existingById = new Map(
    currentModels
      .filter(isCurrentProviderModel)
      .map(model => [String(model?.id || ''), model])
  );
  const selectedModels = providerModels
    .filter(model => selectedIds.has(String(model?.id || '')))
    .map(model => {
      const modelId = String(model.id || '');
      const built = cbBuildModelEntry(provider, modelId, provider.providerName, capabilities, platformId);
      const existing = existingById.get(modelId);
      // 已存在的模型：保留用户自定义值；若仍是历史默认 128K，则升级到推荐值
      if (existing) {
        if (existing.maxInputTokens != null) {
          const rec = cbRecommendContextWindow(modelId);
          if (cbIsLegacyDefaultContext(existing.maxInputTokens) && rec > Number(existing.maxInputTokens)) {
            built.maxInputTokens = rec;
          } else {
            built.maxInputTokens = existing.maxInputTokens;
          }
        }
        if (existing.maxOutputTokens != null) {
          if (Number(existing.maxOutputTokens) === 8192 && built.maxOutputTokens > 8192) {
            // 保留推荐输出上限
          } else {
            built.maxOutputTokens = existing.maxOutputTokens;
          }
        }
        // 用户个性化字段整体迁移（温度 / 实际请求 ID / 图片上限 / 多模态开关 / 思考档位等），
        // 避免"从供应商重新添加"时被固定字段重建冲掉
        for (const key of ['temperature', 'modelId', 'maxImageCount', 'disabledMultimodal', 'reasoning', 'reasoningLevels', 'reasoningLevelMap']) {
          if (existing[key] !== undefined) built[key] = cloneTencentBuddyJson(existing[key]);
        }
        if (existing.enabled === false) built.enabled = false;
      }
      return built;
    });

  ref.setModels([...preservedModels, ...selectedModels]);
  ref.setAvailable(cbMergeAvailableModels(
    cbUniqueStrings(ref.getAvailable()).filter(id => !providerIds.has(String(id || ''))),
    selectedModels
  ));

  return { selectedCount: selectedModels.length, previousSelectedCount };
}

function cbIconSvg(name) {
  const icons = {
    tool: '<svg viewBox="0 0 24 24"><path d="M14.7 6.3a4 4 0 0 0-5.1 5.1L3 18l3 3 6.6-6.6a4 4 0 0 0 5.1-5.1l-2.4 2.4-3-3 2.4-2.4Z"/></svg>',
    image: '<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="8" cy="10" r="1.5"/><path d="m21 15-5-5L5 19"/></svg>',
    reason: '<svg viewBox="0 0 24 24"><path d="M9 18h6"/><path d="M10 22h4"/><path d="M8 14a6 6 0 1 1 8 0c-.8.7-1 1.5-1 2H9c0-.5-.2-1.3-1-2Z"/></svg>',
    key: '<svg viewBox="0 0 24 24"><circle cx="7.5" cy="15.5" r="4.5"/><path d="m11 12 8-8"/><path d="m15 8 3 3"/><path d="m17 6 3 3"/></svg>',
    copy: '<svg viewBox="0 0 24 24"><rect x="9" y="9" width="11" height="11" rx="2"/><rect x="4" y="4" width="11" height="11" rx="2"/></svg>',
    edit: '<svg viewBox="0 0 24 24"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>',
    trash: '<svg viewBox="0 0 24 24"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2"/></svg>',
  };
  return icons[name] || '';
}

function cbCapabilityChip(cls, type, title) {
  return `<span class="${cls}-cap-chip ${cls}-cap-${type}" title="${platformEsc(title)}" aria-label="${platformEsc(title)}">${cbIconSvg(type)}</span>`;
}

// 能力药丸（中文标签，3 色按能力类型区分）
function cbCapabilityPill(cls, type, label) {
  const titles = { tool: '支持工具调用', image: '支持图片理解', reason: '支持深度推理' };
  const title = titles[type] || label;
  return `<span class="${cls}-cap-pill ${cls}-cap-${type}" title="${platformEsc(title)}" aria-label="${platformEsc(title)}">${platformEsc(label)}</span>`;
}

// ---- P3 globalThis mirror ----
(function mirrorFns(g) {
  g.cbRemoveAvailableModel = cbRemoveAvailableModel;
  g.cbReplaceAvailableModel = cbReplaceAvailableModel;
  g.cbProviderChatUrl = cbProviderChatUrl;
  g.zcNormalizeBaseUrl = zcNormalizeBaseUrl;
  g.zcProviderBaseUrl = zcProviderBaseUrl;
  g.zcHashId = zcHashId;
  g.zcProviderIdNeedsMigration = zcProviderIdNeedsMigration;
  g.zcProviderIdForModel = zcProviderIdForModel;
  g.zcProviderIdForProvider = zcProviderIdForProvider;
  g.zcProviderModelKeyParts = zcProviderModelKeyParts;
  g.zcProviderModelKey = zcProviderModelKey;
  g.cbModelSelectionKey = cbModelSelectionKey;
  g.cbProviderApiKey = cbProviderApiKey;
  g.cbSelectedCapability = cbSelectedCapability;
  g.cbRecommendContextWindow = cbRecommendContextWindow;
  g.cbRecommendMaxOutputTokens = cbRecommendMaxOutputTokens;
  g.cbIsLegacyDefaultContext = cbIsLegacyDefaultContext;
  g.cbNormalizeModelContext = cbNormalizeModelContext;
  g.cbNormalizeModelsContext = cbNormalizeModelsContext;
  g.cbFormatContextTokens = cbFormatContextTokens;
  g.cbBuildModelEntry = cbBuildModelEntry;
  g.cbAddModelIdentity = cbAddModelIdentity;
  g.cbOnAddModelCheckChanged = cbOnAddModelCheckChanged;
  g.cbSetAddModelChecks = cbSetAddModelChecks;
  g.cbApplyProviderModelSelection = cbApplyProviderModelSelection;
  g.cbIconSvg = cbIconSvg;
  g.cbCapabilityChip = cbCapabilityChip;
  g.cbCapabilityPill = cbCapabilityPill;
})(globalThis);
