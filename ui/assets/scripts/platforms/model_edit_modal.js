// platforms/model_edit_modal.js — 跨平台模型编辑弹窗与思考档位表单

function cbEditModelsRef(prefix) {
  if (prefix === 'Cb') return { models: cbModels, available: () => cbAvailableModels, render: renderCodeBuddyModels, replace: (oldId, id) => { cbAvailableModels = cbReplaceAvailableModel(cbAvailableModels, oldId, id); }, platform: CB_PLATFORM };
  if (prefix === 'Zc') return { models: zcModels, available: () => zcAvailableModels, render: renderZcModels, replace: (oldId, id) => { zcAvailableModels = cbReplaceAvailableModel(zcAvailableModels, oldId, id); }, platform: ZC_PLATFORM };
  if (MANAGED_MODEL_PLATFORM_IDS[prefix]) {
    const id = prefix.toLowerCase();
    return {
      models: globalThis[`${id}Models`],
      available: () => globalThis[`${id}AvailableModels`],
      render: globalThis[`render${prefix}Models`],
      replace: (oldId, newId) => {
        globalThis[`${id}AvailableModels`] =
          cbReplaceAvailableModel(globalThis[`${id}AvailableModels`], oldId, newId);
      },
      platform: MANAGED_MODEL_PLATFORM_IDS[prefix],
    };
  }
  return { models: wbModels, available: () => wbAvailableModels, render: renderWbModels, replace: (oldId, id) => { wbAvailableModels = cbReplaceAvailableModel(wbAvailableModels, oldId, id); }, platform: WB_PLATFORM };
}

globalThis.cbEditCurrent = { prefix: null, index: -1 };

// ─── ZCode 思考档位（reasoningLevel）─────────────────────────────
// ZCode 把选中的档位值直接透传为请求的 reasoning_effort，因此只提供上游通用的
// 标准档位值；不做按模型 ID 的自动推断——未知模型一律默认不选，由使用者按
// 上游支持情况勾选，留空 = 不配置（回落 ZCode 内置默认，零风险）。
globalThis.ZC_REASONING_LEVEL_VALUES = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
globalThis.ZC_REASONING_LEVEL_PRESET_BUTTONS = [
  { label: '常用三档', levels: ['low', 'medium', 'high'] },
  { label: '全选', levels: [...ZC_REASONING_LEVEL_VALUES] },
  { label: '清空', levels: [] },
];

function zcRenderReasoningLevelChips(selected) {
  const box = document.getElementById('cb-edit-reasoning-levels');
  if (!box) return;
  const sel = new Set(selected || []);
  box.innerHTML = ZC_REASONING_LEVEL_VALUES.map((value) => `
    <label>
      <input type="checkbox" value="${value}" ${sel.has(value) ? 'checked' : ''}>
      <span>${value}</span>
    </label>`).join('');
}

function zcRenderReasoningLevelPresets() {
  const box = document.getElementById('cb-edit-reasoning-presets');
  if (!box || box.dataset.bound === '1') return;
  box.innerHTML = ZC_REASONING_LEVEL_PRESET_BUTTONS.map((preset, i) => `
    <button type="button" data-level-preset="${i}">${preset.label}</button>`).join('');
  box.addEventListener('click', (event) => {
    const btn = event.target.closest('[data-level-preset]');
    if (!btn) return;
    const preset = ZC_REASONING_LEVEL_PRESET_BUTTONS[Number(btn.dataset.levelPreset)];
    if (!preset) return;
    zcRenderReasoningLevelChips(preset.levels);
    // Buddy 平台：档位集合变化后同步刷新"默认档位"下拉
    const sel = document.getElementById('cb-edit-default-effort');
    if (sel) cbRenderDefaultEffortOptions(sel.value);
  });
  box.dataset.bound = '1';
}

function zcCollectReasoningLevels() {
  return Array.from(
    document.querySelectorAll('#cb-edit-reasoning-levels input[type="checkbox"]:checked')
  ).map((el) => el.value);
}

// ─── CodeBuddy / WorkBuddy 思考档位（reasoning.supportedEfforts / defaultEffort）──
// CodeBuddy 客户端默认按界面档位（最高档）发起请求；模型条目里给出 supportedEfforts
// 白名单后，白名单外的请求档位会自动回落到 defaultEffort，避免上游因不认某档位报错。

/** 档位勾选变化时，同步刷新"默认档位"下拉的可选项 */
function cbBindEffortChipsSync() {
  const box = document.getElementById('cb-edit-reasoning-levels');
  if (!box || box.dataset.effortSync === '1') return;
  box.addEventListener('change', () => {
    const sel = document.getElementById('cb-edit-default-effort');
    cbRenderDefaultEffortOptions(sel ? sel.value : '');
  });
  box.dataset.effortSync = '1';
}

/** 渲染默认档位下拉：选项 = 当前已勾选的档位，首个"（不指定）"表示留空 */
function cbRenderDefaultEffortOptions(selected) {
  const sel = document.getElementById('cb-edit-default-effort');
  if (!sel) return;
  const efforts = zcCollectReasoningLevels();
  const keep = efforts.includes(selected) ? selected : '';
  sel.innerHTML = ['', ...efforts]
    .map((v) => `<option value="${v}" ${v === keep ? 'selected' : ''}>${v || '（不指定）'}</option>`)
    .join('');
}

function openCbEditModal(prefix, index) {
  const ref = cbEditModelsRef(prefix);
  const model = ref.models[index];
  if (!model) return;
  cbEditCurrent = { prefix, index };

  const modal = document.getElementById('cb-edit-modal');
  if (!modal) return;

  // Buddy 平台：编辑框展示 name（展示名），vendor 固定为 user 写入时再处理。
  // ZCode：保留 vendor/name 合并编辑。Pi：name 即展示名，vendor 仅用于表格分组展示。
  const isBuddyEdit = prefix === 'Cb' || prefix === 'Wb';
  // 受管平台（Pi / Hermes / Dsh）的供应商字段同样是「展示名」语义
  const isDisplayNameEdit = isBuddyEdit || !!MANAGED_MODEL_PLATFORM_IDS[prefix];
  const vendorOrName = isDisplayNameEdit
    ? (model.name || model.id || '')
    : (model.vendor || model.name || '');
  platformSetValue('cb-edit-id', model.id || '');
  platformSetValue('cb-edit-vendor', vendorOrName);
  platformSetValue('cb-edit-url', prefix === 'Zc' ? zcNormalizeBaseUrl(model.url || '') : model.url || '');
  platformSetValue('cb-edit-key', model.apiKey || '');
  platformSetValue('cb-edit-max-input', model.maxInputTokens != null ? model.maxInputTokens : '');
  platformSetValue('cb-edit-max-output', model.maxOutputTokens != null ? model.maxOutputTokens : '');
  platformSetValue('cb-edit-temperature', model.temperature != null ? model.temperature : '');
  platformSetValue('cb-edit-tools', !!model.supportsToolCall);
  platformSetValue('cb-edit-images', !!model.supportsImages);
  platformSetValue('cb-edit-reasoning', !!model.supportsReasoning);

  // CodeBuddy/WorkBuddy 专属字段：实际请求 ID / 图片数量上限 / 禁用多模态
  platformSetValue('cb-edit-model-override', model.modelId || '');
  platformSetValue('cb-edit-max-images', model.maxImageCount != null ? model.maxImageCount : '');
  platformSetValue('cb-edit-disabled-multimodal', !!model.disabledMultimodal);
  const buddyOnlyFields = ['cb-edit-model-override-item', 'cb-edit-max-images-item', 'cb-edit-disabled-multimodal-item'];
  for (const fieldId of buddyOnlyFields) {
    const el = document.getElementById(fieldId);
    if (el) el.style.display = isBuddyEdit ? '' : 'none';
  }

  // 思考档位面板：ZCode 走 optionSpecs.reasoningLevel；CodeBuddy/WorkBuddy 走模型条目的
  // reasoning 对象（supportedEfforts 白名单 + defaultEffort 回落档）。
  // 不做按 ID 推断：有保存值回填，否则默认全不选（留空 = 不配置，保持客户端默认透传）。
  const levelsField = document.getElementById('cb-edit-reasoning-levels-field');
  const levelsMapField = document.getElementById('cb-edit-reasoning-map-field');
  const buddyEffortExtra = document.getElementById('cb-edit-buddy-effort-extra');
  const buddyThinkingExtra = document.getElementById('cb-edit-buddy-thinking-extra');
  const reasoningTitle = document.getElementById('cb-edit-reasoning-title');
  const reasoningSubtitle = document.getElementById('cb-edit-reasoning-subtitle');
  const reasoningHint = document.getElementById('cb-edit-reasoning-hint');
  const showReasoningLevels = prefix === 'Zc' || isBuddyEdit;
  if (levelsField) levelsField.style.display = showReasoningLevels ? '' : 'none';
  if (showReasoningLevels) {
    zcRenderReasoningLevelPresets();
    if (prefix === 'Zc') {
      if (levelsMapField) levelsMapField.style.display = '';
      if (buddyEffortExtra) buddyEffortExtra.style.display = 'none';
      if (buddyThinkingExtra) buddyThinkingExtra.style.display = 'none';
      if (reasoningTitle) reasoningTitle.textContent = '思考档位';
      if (reasoningSubtitle) reasoningSubtitle.textContent = '选中的档位可在聊天界面自由切换，留空则保持默认';
      zcRenderReasoningLevelChips(
        Array.isArray(model.reasoningLevels) ? model.reasoningLevels : []
      );
      const mapEl = document.getElementById('cb-edit-reasoning-map');
      if (mapEl) mapEl.value = model.reasoningLevelMap || '';
      const detailsEl = document.getElementById('cb-edit-reasoning-map-field');
      if (detailsEl) detailsEl.open = !!(model.reasoningLevelMap && model.reasoningLevelMap.trim());
      if (reasoningHint) {
        reasoningHint.textContent = '仅勾选上游模型支持的档位（如 gpt-5.6 系支持全套，gemini/claude 走模型名后缀请留空）；切换档位在 ZCode 聊天界面的模型选择器中进行';
      }
    } else {
      if (levelsMapField) levelsMapField.style.display = 'none';
      if (buddyEffortExtra) buddyEffortExtra.style.display = '';
      if (buddyThinkingExtra) buddyThinkingExtra.style.display = '';
      if (reasoningTitle) reasoningTitle.textContent = '思考档位白名单';
      if (reasoningSubtitle) reasoningSubtitle.textContent = '只勾选上游实际支持的档位，未勾选的档位永远不会被发送';
      zcRenderReasoningLevelChips(
        Array.isArray(model.reasoning?.supportedEfforts) ? model.reasoning.supportedEfforts : []
      );
      cbBindEffortChipsSync();
      cbRenderDefaultEffortOptions(model.reasoning?.defaultEffort || '');
      // 思考开关：onlyReasoning 与 canDisableThinking 都会让聊天界面隐藏「关闭思考」；
      // 「允许关闭思考」默认勾选（= 不写 canDisableThinking，保持客户端默认）。
      platformSetValue('cb-edit-only-reasoning', !!model.onlyReasoning);
      platformSetValue('cb-edit-allow-disable-thinking', model.reasoning?.canDisableThinking !== false);
      platformSetValue('cb-edit-reasoning-summary', model.reasoning?.summary || '');
      if (reasoningHint) {
        reasoningHint.textContent = '留空 = 不限制（客户端请求的档位原样透传给上游）；配置白名单后，白名单外的请求档位会自动回落到默认档，可避免上游不认某个档位时报 400';
      }
    }
  } else {
    if (levelsMapField) levelsMapField.style.display = 'none';
    if (buddyEffortExtra) buddyEffortExtra.style.display = 'none';
    if (buddyThinkingExtra) buddyThinkingExtra.style.display = 'none';
  }

  // ZCode 的个人配置不含工具调用字段（由 ZCode 内置默认恒为启用），隐藏无效勾选避免误导。
  const toolsField = document.getElementById('cb-edit-tools');
  if (toolsField) {
    const toolsLabel = toolsField.closest('label');
    if (toolsLabel) toolsLabel.style.display = prefix === 'Zc' ? 'none' : '';
  }

  const recInput = cbRecommendContextWindow(model.id || '');
  const recOutput = cbRecommendMaxOutputTokens(model.id || '');
  const inputEl = document.getElementById('cb-edit-max-input');
  if (inputEl) inputEl.placeholder = `推荐值: ${recInput}（${cbFormatContextTokens(recInput)}）`;
  const outputEl = document.getElementById('cb-edit-max-output');
  if (outputEl) outputEl.placeholder = `推荐值: ${recOutput}`;

  // 标题展示平台名
  const titleEl = document.getElementById('cb-edit-modal-title');
  if (titleEl) {
    const platformLabel = (typeof platformDef === 'function' ? platformDef(ref.platform).name : '') || prefix;
    titleEl.textContent = `编辑模型 · ${platformLabel}`;
  }
  const vendorLabel = document.querySelector('label[for="cb-edit-vendor"]');
  const vendorInput = document.getElementById('cb-edit-vendor');
  if (vendorLabel) {
    vendorLabel.innerHTML = isDisplayNameEdit
      ? '展示名 <span style="color:var(--danger);">*</span>'
      : '供应商 <span style="color:var(--danger);">*</span>';
  }
  if (vendorInput) {
    vendorInput.placeholder = isDisplayNameEdit
      ? '供应商展示名，如 CPA / OpenAI'
      : '模型供应商，如 OpenAI / Google / 黑与白';
  }
  const urlLabel = document.querySelector('label[for="cb-edit-url"]');
  const urlInput = document.getElementById('cb-edit-url');
  if (urlLabel) {
    urlLabel.innerHTML = prefix === 'Zc'
      ? 'Base URL <span style="color:var(--danger);">*</span>'
      : '接口地址 <span style="color:var(--danger);">*</span>';
  }
  if (urlInput) {
    urlInput.placeholder = prefix === 'Zc'
      ? 'OpenAI 兼容基础地址，如 https://api.example.com/v1'
      : prefix === 'Pi'
        ? 'OpenAI 兼容端点完整路径，如 https://api.example.com/v1/chat/completions'
        : 'API 端点完整路径，必须以 /chat/completions 结尾';
  }

  modal.classList.add('active');
  document.body.classList.add('modal-open');
  setTimeout(() => {
    const firstInput = document.getElementById('cb-edit-id');
    if (firstInput) firstInput.focus();
  }, 30);
}

function closeCbEditModal() {
  const modal = document.getElementById('cb-edit-modal');
  if (modal) modal.classList.remove('active');
  document.body.classList.remove('modal-open');
  cbEditCurrent = { prefix: null, index: -1 };
}

function cbFillRecommendedContext() {
  const modelId = (document.getElementById('cb-edit-id')?.value || '').trim();
  if (!modelId) {
    if (typeof showCustomAlert === 'function') {
      showCustomAlert('请先输入模型 ID，再填入推荐值', '提示', 'info');
    }
    return;
  }
  const inputTokens = cbRecommendContextWindow(modelId);
  const outputTokens = cbRecommendMaxOutputTokens(modelId);
  platformSetValue('cb-edit-max-input', inputTokens);
  platformSetValue('cb-edit-max-output', outputTokens);
  const inputEl = document.getElementById('cb-edit-max-input');
  if (inputEl) inputEl.placeholder = `推荐值: ${inputTokens}（${cbFormatContextTokens(inputTokens)}）`;
  const outputEl = document.getElementById('cb-edit-max-output');
  if (outputEl) outputEl.placeholder = `推荐值: ${outputTokens}`;
  if (typeof showBottomToast === 'function') {
    showBottomToast(`已填入推荐设置：上下文 ${cbFormatContextTokens(inputTokens)} / 输出 ${outputTokens}`, 'success');
  }
}

async function saveCbEditFromModal() {
  const { prefix, index } = cbEditCurrent;
  if (!prefix || index < 0) return;
  const ref = cbEditModelsRef(prefix);
  const listRef = cbModelListRef(prefix);
  const model = ref.models[index];
  if (!model) return;

  // 必填字段（4 个）：id / 展示名 / url / apiKey
  const id = (document.getElementById('cb-edit-id')?.value || '').trim();
  const displayName = (document.getElementById('cb-edit-vendor')?.value || '').trim();
  const rawUrl = (document.getElementById('cb-edit-url')?.value || '').trim();
  const url = prefix === 'Zc' ? zcNormalizeBaseUrl(rawUrl) : rawUrl;
  const apiKey = (document.getElementById('cb-edit-key')?.value || '').trim();
  const isBuddyEdit = prefix === 'Cb' || prefix === 'Wb';

  // 必填校验
  const missing = [];
  if (!id) missing.push('模型 ID');
  if (!displayName) missing.push(isBuddyEdit || prefix === 'Pi' ? '展示名' : '供应商');
  if (!url) missing.push('接口地址');
  if (!apiKey) missing.push('API 密钥');
  if (missing.length) {
    showCustomAlert(`以下必填字段不能为空：\n${missing.join('、')}`, '输入错误', 'warn');
    return;
  }

  // 选填字段：留空不写
  const maxInputStr = (document.getElementById('cb-edit-max-input')?.value || '').trim();
  const maxOutputStr = (document.getElementById('cb-edit-max-output')?.value || '').trim();
  const tempStr = (document.getElementById('cb-edit-temperature')?.value || '').trim();
  const supportsToolCall = !!document.getElementById('cb-edit-tools')?.checked;
  const supportsImages = !!document.getElementById('cb-edit-images')?.checked;
  const supportsReasoning = !!document.getElementById('cb-edit-reasoning')?.checked;

  // 数字字段转换：空字符串或非数字 → 留空
  const parseNum = (v) => {
    if (v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const maxInput = parseNum(maxInputStr);
  const maxOutput = parseNum(maxOutputStr);
  const temperature = parseNum(tempStr);

  // Buddy：vendor 固定 "user"，name 用展示名；ZCode：name/vendor 同值保留旧语义。
  // 以原条目为基底展开，保留外部写入/同步进来的其他字段。
  const oldId = model.id || '';
  const entry = {
    ...model,
    id,
    name: displayName,
    vendor: isBuddyEdit ? 'user' : displayName,
    url,
    apiKey,
  };
  // 留空或取消勾选时显式删除键，保证"清空即清除"语义
  if (maxInput != null) entry.maxInputTokens = maxInput; else delete entry.maxInputTokens;
  if (maxOutput != null) entry.maxOutputTokens = maxOutput; else delete entry.maxOutputTokens;
  if (temperature != null) entry.temperature = temperature; else delete entry.temperature;
  if (supportsToolCall) entry.supportsToolCall = true; else delete entry.supportsToolCall;
  if (supportsImages) entry.supportsImages = true; else delete entry.supportsImages;
  if (supportsReasoning) entry.supportsReasoning = true; else delete entry.supportsReasoning;

  // CodeBuddy/WorkBuddy 专属字段（ZCode 条目不写这些键）
  if (isBuddyEdit) {
    const modelOverride = (document.getElementById('cb-edit-model-override')?.value || '').trim();
    if (modelOverride) entry.modelId = modelOverride; else delete entry.modelId;

    // 0 会被 CodeBuddy 按 falsy 回落到默认 20，非正数等同留空
    const maxImages = parseNum((document.getElementById('cb-edit-max-images')?.value || '').trim());
    if (maxImages != null && maxImages > 0) entry.maxImageCount = maxImages;
    else delete entry.maxImageCount;

    if (document.getElementById('cb-edit-disabled-multimodal')?.checked) entry.disabledMultimodal = true;
    else delete entry.disabledMultimodal;

    // 思考档位白名单 + 默认档位（留空 = 不配置，删除旧键实现清除）
    const efforts = zcCollectReasoningLevels();
    const defEffort = (document.getElementById('cb-edit-default-effort')?.value || '').trim();
    const reasoning = {};
    if (efforts.length > 0) reasoning.supportedEfforts = efforts;
    if (defEffort && (efforts.length === 0 || efforts.includes(defEffort))) reasoning.defaultEffort = defEffort;
    // 思考开关：取消勾选「允许关闭思考」→ canDisableThinking=false，聊天界面不再出现 Off
    if (!document.getElementById('cb-edit-allow-disable-thinking')?.checked) reasoning.canDisableThinking = false;
    const summaryMode = (document.getElementById('cb-edit-reasoning-summary')?.value || '').trim();
    if (summaryMode) reasoning.summary = summaryMode;
    if (Object.keys(reasoning).length > 0) entry.reasoning = reasoning;
    else delete entry.reasoning;

    // onlyReasoning 与 reasoning 平级，客户端同样用它隐藏「关闭思考」
    if (document.getElementById('cb-edit-only-reasoning')?.checked) entry.onlyReasoning = true;
    else delete entry.onlyReasoning;
  }

  // ZCode：思考档位写入条目（空数组 = 不配置，删除旧键实现"清除"）
  if (prefix === 'Zc') {
    const reasoningLevels = zcCollectReasoningLevels();
    if (reasoningLevels.length > 0) {
      entry.reasoningLevels = reasoningLevels;
      const mapRaw = (document.getElementById('cb-edit-reasoning-map')?.value || '').trim();
      if (mapRaw) entry.reasoningLevelMap = mapRaw;
    } else {
      delete entry.reasoningLevels;
      delete entry.reasoningLevelMap;
    }
  }

  // WorkBuddy 必须保持 useCustomProtocol；从 CodeBuddy 同步过来的模型也要补写
  if (prefix === 'Wb' || ref.platform === WB_PLATFORM) entry.useCustomProtocol = true;
  if (prefix === 'Zc') entry.providerId = zcProviderIdForModel({ ...model, ...entry });

  const previousModels = listRef.getModels().slice();
  const previousAvailable = listRef.getAvailable().slice();
  ref.models[index] = entry;
  ref.replace(oldId, id);
  ref.render();
  try {
    await listRef.save({ silent: true, throwOnError: true });
    closeCbEditModal();
    if (typeof showBottomToast === 'function') showBottomToast('模型已保存', 'success');
  } catch (e) {
    listRef.setModels(previousModels);
    listRef.setAvailable(previousAvailable);
    listRef.render();
    showCustomAlert(`保存失败，已恢复编辑前状态：${e}`, '保存失败', 'error');
  }
}

// ---- P3 globalThis mirror ----
(function mirrorFns(g) {
  g.cbEditModelsRef = cbEditModelsRef;
  g.zcRenderReasoningLevelChips = zcRenderReasoningLevelChips;
  g.zcRenderReasoningLevelPresets = zcRenderReasoningLevelPresets;
  g.zcCollectReasoningLevels = zcCollectReasoningLevels;
  g.cbBindEffortChipsSync = cbBindEffortChipsSync;
  g.cbRenderDefaultEffortOptions = cbRenderDefaultEffortOptions;
  g.openCbEditModal = openCbEditModal;
  g.closeCbEditModal = closeCbEditModal;
  g.cbFillRecommendedContext = cbFillRecommendedContext;
  g.saveCbEditFromModal = saveCbEditFromModal;
})(globalThis);
