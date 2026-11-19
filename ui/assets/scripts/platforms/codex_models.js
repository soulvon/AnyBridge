// platforms/codex_models.js — split from 55-platforms.js
function syncCodexRawConfigFromFields() {
  const textarea = document.getElementById('codex-config-raw-toml');
  if (!textarea) return;
  const name = document.getElementById('codex-config-name')?.value.trim() || 'CustomProvider';
  const baseUrl = document.getElementById('codex-config-base-url')?.value.trim() || 'http://127.0.0.1:7450/v1';
  const apiKey = document.getElementById('codex-config-api-key')?.value.trim() || '';
  const defaultModel = document.getElementById('codex-config-model')?.value.trim() || '';
  const routeThroughProxy = document.getElementById('codex-config-route-through-proxy')?.checked !== false;
  const preserveAuth = document.getElementById('codex-config-preserve-official-auth')?.checked === true;

  const effectiveBase = routeThroughProxy ? 'http://127.0.0.1:7450/v1' : baseUrl;

  const lines = [
    `# ~/.codex/config.toml 当前配置段落预览`
  ];
  if (defaultModel) lines.push(`model = "${defaultModel}"`);
  lines.push(`model_provider = "codex_local_access"\n`);
  lines.push(`[model_providers.codex_local_access]`);
  lines.push(`name = "${name}"`);
  lines.push(`base_url = "${effectiveBase}"`);
  lines.push(`wire_api = "responses"`);
  if (preserveAuth) {
    lines.push(`requires_openai_auth = true`);
  } else {
    lines.push(`requires_openai_auth = false`);
    if (apiKey) lines.push(`experimental_bearer_token = "${apiKey}"`);
  }

  const entries = typeof getCodexModelEntries === 'function' ? getCodexModelEntries() : [];
  const inCatalog = entries.filter(e => e.inCatalog);
  if (inCatalog.length) {
    lines.push('');
    for (const m of inCatalog) {
      lines.push(`[[model_providers.codex_local_access.models]]`);
      lines.push(`name = "${m.model}"`);
      if (m.displayName) lines.push(`display_name = "${m.displayName}"`);
      if (m.contextWindow) lines.push(`context_window = ${m.contextWindow}`);
    }
  }
  textarea.value = lines.join('\n');
}

function renderCodexModelManager(entries, defaultModel = '', status = '') {
  const container = document.getElementById('codex-config-model-list');
  if (!container) return;
  const list = Array.isArray(entries) ? entries : [];
  if (defaultModel) {
    list.forEach(e => { e.isDefault = (e.model === defaultModel); });
  }
  codexConfigSetInputValue('codex-config-models', list.map(e => e.model).join('\n'));
  codexConfigSetInputValue('codex-config-model', defaultModel || '');

  if (!list.length) {
    container.innerHTML = '<div class="codex-config-model-empty">还没有模型，点击右上角拉取或手动添加。</div>';
    if (status) codexConfigSetModelStatus(status);
    setCodexModelEntriesState([]);
    return;
  }
  setCodexModelEntriesState(list);
  // 不传 status 时：自动显示"目录 x/总数 · 默认 xxx"
  if (!status) {
    const total = list.length;
    const inCat = list.filter(e => e.inCatalog).length;
    const dflt = list.find(e => e.isDefault)?.model || '';
    const parts = [`目录 ${inCat}/${total}`];
    if (dflt) parts.push(`默认 ${dflt}`);
    codexConfigSetModelStatus(parts.join(' · '));
  }
  container.innerHTML = list.map((entry, i) => {
    const model = platformEsc(entry.model || '');
    const displayName = platformEsc(entry.displayName || '');
    const ctx = platformEsc(String(entry.contextWindow || ''));
    const checked = entry.inCatalog ? 'checked' : '';
    const isDefault = entry.isDefault;
    const activeClass = isDefault ? ' active' : '';
    const defaultBtnClass = isDefault ? 'codex-model-default-btn is-default' : 'codex-model-default-btn';
    const defaultBtnText = isDefault ? '默认 ✓' : '设为默认';
    const defaultBtnClick = isDefault
      ? `selectCodexDefaultModel('')`
      : `selectCodexDefaultModel('${model}')`;
    const icon = typeof renderModelIcon === 'function' ? renderModelIcon(entry.model) : '';
    return `<div class="codex-config-model-option${activeClass}" data-idx="${i}" data-model="${model}" data-display="${displayName}" data-ctx="${ctx}">
      <input type="checkbox" ${checked} data-action="toggleCodexModelCatalog" data-events="change" data-args="[${i}]" title="加入模型目录">
      <span class="codex-model-icon-wrap">${icon}</span>
      <span class="codex-model-name" title="${model}">${model}</span>
      ${displayName ? `<span class="codex-model-display-name">${displayName}</span>` : ''}
      ${ctx ? `<span class="codex-model-ctx">${ctx}</span>` : ''}
      <div class="codex-model-actions">
        <button type="button" class="${defaultBtnClass}" data-action-call="${defaultBtnClick}">${defaultBtnText}</button>
        <button type="button" class="codex-config-fetch-btn" data-action="editCodexModelEntry" data-args="[${i}]">编辑</button>
        <button type="button" class="codex-config-catalog-del" data-action="removeCodexModelEntry" data-args="[${i}]">删除</button>
      </div>
    </div>`;
  }).join('');
  if (status) codexConfigSetModelStatus(status);
  if (document.getElementById('codex-agents-list')) {
    renderCodexAgentsPanel(null, codexAgentsState);
  }
  syncCodexRawConfigFromFields();
}

// 从状态缓存读（避免 re-render 时 DOM 已被替换导致读到旧值）
function getCodexModelEntries() {
  if (codexModelEntriesState.length) {
    return codexModelEntriesState.map(e => ({ ...e }));
  }
  // 状态为空时回退到 DOM 读取（首次进入编辑器等场景）
  const container = document.getElementById('codex-config-model-list');
  if (!container) return [];
  const rows = container.querySelectorAll('.codex-config-model-option[data-idx]');
  const entries = [];
  for (const row of rows) {
    const checkbox = row.querySelector('input[type="checkbox"]');
    if (!checkbox) continue;
    const model = row.dataset.model || '';
    if (!model) continue;
    const displayName = row.dataset.display || '';
    const ctxStr = row.dataset.ctx || '';
    const inCatalog = checkbox.checked || false;
    const isDefault = row.classList.contains('active');
    const entry = { model, inCatalog, isDefault };
    if (displayName) entry.displayName = displayName;
    if (ctxStr) {
      const ctx = Number(ctxStr);
      if (Number.isFinite(ctx) && ctx > 0) entry.contextWindow = ctx;
    }
    entries.push(entry);
  }
  return entries;
}

// 独立的 entries 状态缓存，避免 onchange 时从 DOM checkbox.checked 读到
// 已变化的值（导致"点取消→又变回勾上"的反向 bug）
globalThis.codexModelEntriesState = [];

function setCodexModelEntriesState(entries) {
  codexModelEntriesState = entries.map(e => ({ ...e }));
}

function toggleCodexModelCatalog(idx) {
  if (!codexModelEntriesState[idx]) return;
  codexModelEntriesState[idx].inCatalog = !codexModelEntriesState[idx].inCatalog;
  if (!codexModelEntriesState[idx].inCatalog) codexModelEntriesState[idx].isDefault = false;
  const defaultModel = codexModelEntriesState.find(e => e.isDefault)?.model || '';
  renderCodexModelManager(codexModelEntriesState, defaultModel);
}

function cancelCodexModelEdit() {
  const entries = getCodexModelEntries();
  const def = entries.find(e => e.isDefault)?.model || '';
  renderCodexModelManager(entries, def);
}

function selectCodexDefaultModel(model) {
  const entries = getCodexModelEntries();
  const defaultModel = String(model || '').trim();
  entries.forEach(e => { e.isDefault = (e.model === defaultModel); });
  renderCodexModelManager(entries, defaultModel);
  codexConfigSetModelStatus(defaultModel ? `默认模型：${defaultModel}` : '已清空默认模型', defaultModel ? 'success' : '');
}

function addCodexModelEntry() {
  const entries = getCodexModelEntries();
  entries.push({ model: '', displayName: '', contextWindow: '', inCatalog: true, isDefault: false });
  renderCodexModelManager(entries, entries.find(e => e.isDefault)?.model || '');
  editCodexModelEntry(entries.length - 1);
}

function editCodexModelEntry(idx) {
  const container = document.getElementById('codex-config-model-list');
  if (!container) return;
  const row = container.querySelectorAll('.codex-config-model-option[data-idx]')[idx];
  if (!row) return;
  const entries = getCodexModelEntries();
  const entry = entries[idx];
  if (!entry) return;
  row.classList.remove('active');
  row.innerHTML = `<div class="codex-config-catalog-row" style="width:100%">
    <input class="field-input" placeholder="模型 ID" value="${platformEsc(entry.model)}">
    <input class="field-input" placeholder="显示名（可选）" value="${platformEsc(entry.displayName)}">
    <input class="field-input" placeholder="上下文窗口" value="${platformEsc(String(entry.contextWindow || ''))}">
    <div style="display:flex;gap:4px">
      <button type="button" class="codex-config-fetch-btn" data-action="saveCodexModelEdit" data-args="[${idx}]">确定</button>
      <button type="button" class="codex-config-catalog-del" data-action="cancelCodexModelEdit">取消</button>
    </div>
  </div>`;
  row.querySelector('.field-input')?.focus();
}

function saveCodexModelEdit(idx) {
  const container = document.getElementById('codex-config-model-list');
  if (!container) return;
  const row = container.querySelectorAll('.codex-config-model-option[data-idx]')[idx];
  if (!row) return;
  const entries = getCodexModelEntries();
  const inputs = row.querySelectorAll('.field-input');
  const model = inputs[0]?.value?.trim() || '';
  if (!model) return;
  entries[idx].model = model;
  entries[idx].displayName = inputs[1]?.value?.trim() || '';
  const ctxStr = inputs[2]?.value?.trim() || '';
  if (ctxStr) {
    const ctx = Number(ctxStr);
    if (Number.isFinite(ctx) && ctx > 0) entries[idx].contextWindow = ctx;
  }
  const defaultModel = entries.find(e => e.isDefault)?.model || '';
  renderCodexModelManager(entries, defaultModel);
}

function removeCodexModelEntry(idx) {
  const entries = getCodexModelEntries();
  if (!entries[idx]) return;
  entries.splice(idx, 1);
  const defaultModel = entries.find(e => e.isDefault)?.model || '';
  renderCodexModelManager(entries, defaultModel);
}

function batchSetCodexModelCatalog(inCatalog) {
  const entries = getCodexModelEntries();
  if (!entries.length) return;
  entries.forEach(e => {
    e.inCatalog = inCatalog;
    if (!inCatalog) e.isDefault = false;
  });
  const defaultModel = entries.find(e => e.isDefault)?.model || '';
  renderCodexModelManager(entries, defaultModel);
  codexConfigSetModelStatus(inCatalog ? `已加入 ${entries.length} 个模型到目录` : `已清空目录`, inCatalog ? 'success' : '');
  setTimeout(() => renderCodexModelManager(getCodexModelEntries(), codexConfigGetDefaultModel()), 1500);
}

function batchSetCodexDefaultModel() {
  const entries = getCodexModelEntries();
  if (!entries.length) return;
  entries.forEach(e => { e.isDefault = false; });
  renderCodexModelManager(entries, '');
  codexConfigSetModelStatus('已清空默认模型', '');
  setTimeout(() => renderCodexModelManager(getCodexModelEntries(), ''), 1500);
}

function codexConfigGetDefaultModel() {
  return String(document.getElementById('codex-config-model')?.value || '').trim();
}

function codexConfigEndpointParts(baseUrl) {
  if (typeof providerEndpointParts === 'function') {
    return providerEndpointParts(baseUrl, 'openai', '/v1');
  }
  let apiHost = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(apiHost)) apiHost = `https://${apiHost}`;
  try {
    const url = new URL(apiHost);
    const apiPath = url.pathname && url.pathname !== '/' ? url.pathname : '/v1';
    return { apiHost: url.origin, apiPath };
  } catch {
    return { apiHost, apiPath: '/v1' };
  }
}

async function fetchCodexConfigModels() {
  if (!invoke) return;
  const baseUrl = String(document.getElementById('codex-config-base-url')?.value || '').trim();
  const apiKey = String(document.getElementById('codex-config-api-key')?.value || '').trim();
  if (!baseUrl || !apiKey) {
    showCustomAlert('请先填写 Base URL 和 API Key。', '无法拉取模型', 'warn');
    return;
  }

  await runRaceGuardedModelFetch({
    getSeq: () => codexConfigModelFetchSeq,
    bumpSeq: () => ++codexConfigModelFetchSeq,
    setLoadingFn: codexConfigSetFetchLoading,
    setStatusFn: codexConfigSetModelStatus,
    loadingStatusText: '正在拉取模型列表...',
    fetcher: async () => {
      const endpoint = codexConfigEndpointParts(baseUrl);
      return invoke('fetch_models', {
        args: {
          host: endpoint.apiHost,
          api_key: apiKey,
          api_format: 'openai',
          path: endpoint.apiPath || '/v1',
        }
      });
    },
    onSuccess: (result) => {
      const fetchedModels = (result?.models || []).map(m => String(m || '').trim()).filter(Boolean);
      if (!fetchedModels.length) throw new Error('接口返回的模型列表为空');
      // 合并到已有列表：已有的保留状态，新拉取的默认不勾选
      const existing = getCodexModelEntries();
      const existingMap = new Map(existing.map(e => [e.model, e]));
      const merged = [];
      for (const entry of existing) {
        merged.push({ ...entry });
      }
      for (const model of fetchedModels) {
        if (!existingMap.has(model)) {
          merged.push({ model, displayName: '', contextWindow: '', inCatalog: false, isDefault: false });
        }
      }
      const currentDefault = existing.find(e => e.isDefault)?.model || '';
      renderCodexModelManager(merged, currentDefault, `已拉取 ${fetchedModels.length} 个模型`);
      codexConfigSetModelStatus(`已拉取 ${fetchedModels.length} 个模型`, 'success');
      if (typeof addLog === 'function') addLog('ok', `Codex 配置模型拉取成功: ${fetchedModels.length} 个`);
    },
    onError: (e) => {
      codexConfigSetModelStatus('拉取失败，可手动添加模型', 'error');
      if (typeof addLog === 'function') addLog('warn', `Codex 配置模型拉取失败: ${e}`);
      showCustomAlert(String(e), '模型拉取失败', 'error');
    },
  });
}

function codexConfigDisplayBaseUrl(provider) {
  if (!provider) return '';
  return codexTargetBaseUrl(provider) || platformJoinUrl(provider.apiHost, provider.apiPath);
}

function codexConfigSetInputValue(id, value) {
  const el = document.getElementById(id);
  if (el) el.value = value == null ? '' : String(value);
}

// ── Reasoning 配置编辑 ──
function renderReasoningConfig(config) {
  const r = config || {};
  codexConfigSetInputValue('codex-config-reasoning-thinking', r.thinkingParam || 'none');
  codexConfigSetInputValue('codex-config-reasoning-effort', r.effortParam || 'none');
  codexConfigSetInputValue('codex-config-reasoning-effort-mode', r.effortValueMode || 'passthrough');
  codexConfigSetInputValue('codex-config-reasoning-output', r.outputFormat || 'auto');
}

function getReasoningConfig() {
  const thinkingParam = String(document.getElementById('codex-config-reasoning-thinking')?.value || 'none').trim();
  const effortParam = String(document.getElementById('codex-config-reasoning-effort')?.value || 'none').trim();
  const effortValueMode = String(document.getElementById('codex-config-reasoning-effort-mode')?.value || 'passthrough').trim();
  const outputFormat = String(document.getElementById('codex-config-reasoning-output')?.value || 'auto').trim();
  if (thinkingParam === 'none' && effortParam === 'none') return undefined;
  return {
    supportsThinking: thinkingParam !== 'none',
    supportsEffort: effortParam !== 'none',
    thinkingParam: thinkingParam !== 'none' ? thinkingParam : undefined,
    effortParam: effortParam !== 'none' ? effortParam : undefined,
    effortValueMode: effortValueMode !== 'passthrough' ? effortValueMode : undefined,
    outputFormat: outputFormat !== 'auto' ? outputFormat : undefined,
  };
}

function codexAgentModelOptions(selected = '') {
  const models = getCodexModelEntries().map(e => e.model).filter(Boolean);
  if (selected && !models.includes(selected)) models.unshift(selected);
  const inherited = `<option value="" ${selected ? '' : 'selected'}>继承父会话模型</option>`;
  return inherited + models.map(model =>
    `<option value="${platformEsc(model)}" ${model === selected ? 'selected' : ''}>${platformEsc(model)}</option>`
  ).join('');
}

function normalizeCodexAgent(agent = {}) {
  return {
    name: String(agent.name || '').trim(),
    description: String(agent.description || '').trim(),
    developerInstructions: String(agent.developerInstructions || '').trim(),
    model: String(agent.model || '').trim(),
    modelReasoningEffort: String(agent.modelReasoningEffort || '').trim(),
    sandboxMode: String(agent.sandboxMode || '').trim(),
    nicknameCandidates: Array.isArray(agent.nicknameCandidates)
      ? agent.nicknameCandidates.map(n => String(n || '').trim()).filter(Boolean)
      : String(agent.nicknameCandidates || '').split(/[,，\n]/).map(n => n.trim()).filter(Boolean),
  };
}

function renderCodexAgentsPanel(config = null, agents = null) {
  if (config) {
    codexConfigSetInputValue('codex-agents-max-threads', config.maxThreads || 6);
    codexConfigSetInputValue('codex-agents-max-depth', config.maxDepth || 1);
    codexConfigSetInputValue('codex-agents-job-timeout', config.jobMaxRuntimeSeconds || 1800);
  }
  if (Array.isArray(agents)) {
    codexAgentsState = agents.map(normalizeCodexAgent);
  }
  const count = document.getElementById('codex-agents-count');
  if (count) count.textContent = String(codexAgentsState.length);
  const list = document.getElementById('codex-agents-list');
  if (!list) return;
  if (!codexAgentsState.length) {
    list.innerHTML = '<div class="codex-config-model-empty">尚未配置子代理。Codex 只会在用户明确要求时调用子代理。</div>';
    return;
  }
  list.innerHTML = codexAgentsState.map((agent, idx) => {
    const nicknames = agent.nicknameCandidates.join(', ');
    return `<div class="codex-agent-card" data-idx="${idx}">
      <div class="codex-agent-card-head">
        <strong>${platformEsc(agent.name || `agent-${idx + 1}`)}</strong>
        <button type="button" class="codex-config-catalog-del" data-action="removeCodexAgent" data-args="[${idx}]">删除</button>
      </div>
      <div class="codex-agent-grid">
        <label class="codex-config-field">
          <span>名称</span>
          <input class="field-input" value="${platformEsc(agent.name)}" placeholder="code-reviewer" data-action="updateCodexAgentField" data-events="input" data-args="[${idx},&quot;name&quot;]" data-pass-value>
        </label>
        <label class="codex-config-field">
          <span>模型</span>
          <select class="field-input" data-action="updateCodexAgentField" data-events="change" data-args="[${idx},&quot;model&quot;]" data-pass-value>
            ${codexAgentModelOptions(agent.model)}
          </select>
        </label>
        <label class="codex-config-field">
          <span>推理强度</span>
          <select class="field-input" data-action="updateCodexAgentField" data-events="change" data-args="[${idx},&quot;modelReasoningEffort&quot;]" data-pass-value>
            <option value="" ${agent.modelReasoningEffort ? '' : 'selected'}>继承</option>
            <option value="low" ${agent.modelReasoningEffort === 'low' ? 'selected' : ''}>low</option>
            <option value="medium" ${agent.modelReasoningEffort === 'medium' ? 'selected' : ''}>medium</option>
            <option value="high" ${agent.modelReasoningEffort === 'high' ? 'selected' : ''}>high</option>
          </select>
        </label>
        <label class="codex-config-field">
          <span>Sandbox</span>
          <select class="field-input" data-action="updateCodexAgentField" data-events="change" data-args="[${idx},&quot;sandboxMode&quot;]" data-pass-value>
            <option value="" ${agent.sandboxMode ? '' : 'selected'}>继承</option>
            <option value="read-only" ${agent.sandboxMode === 'read-only' ? 'selected' : ''}>read-only</option>
            <option value="workspace-write" ${agent.sandboxMode === 'workspace-write' ? 'selected' : ''}>workspace-write</option>
            <option value="danger-full-access" ${agent.sandboxMode === 'danger-full-access' ? 'selected' : ''}>danger-full-access</option>
          </select>
        </label>
      </div>
      <label class="codex-config-field">
        <span>描述</span>
        <input class="field-input" value="${platformEsc(agent.description)}" placeholder="PR reviewer focused on correctness..." data-action="updateCodexAgentField" data-events="input" data-args="[${idx},&quot;description&quot;]" data-pass-value>
      </label>
      <label class="codex-config-field">
        <span>昵称候选（逗号分隔）</span>
        <input class="field-input" value="${platformEsc(nicknames)}" placeholder="Atlas, Delta" data-action="updateCodexAgentField" data-events="input" data-args="[${idx},&quot;nicknameCandidates&quot;]" data-pass-value>
      </label>
      <label class="codex-config-field">
        <span>Developer Instructions</span>
        <textarea class="field-input codex-agent-instructions" placeholder="Review code like an owner..." data-action="updateCodexAgentField" data-events="input" data-args="[${idx},&quot;developerInstructions&quot;]" data-pass-value>${platformEsc(agent.developerInstructions)}</textarea>
      </label>
    </div>`;
  }).join('');
}

function addCodexAgent() {
  codexAgentsState.push({
    name: `agent-${codexAgentsState.length + 1}`,
    description: '',
    developerInstructions: '',
    model: '',
    modelReasoningEffort: '',
    sandboxMode: 'read-only',
    nicknameCandidates: [],
  });
  renderCodexAgentsPanel(null, codexAgentsState);
}

function removeCodexAgent(idx) {
  codexAgentsState.splice(idx, 1);
  renderCodexAgentsPanel(null, codexAgentsState);
}

function updateCodexAgentField(idx, field, value) {
  if (!codexAgentsState[idx]) return;
  if (field === 'nicknameCandidates') {
    codexAgentsState[idx][field] = String(value || '').split(/[,，\n]/).map(n => n.trim()).filter(Boolean);
  } else {
    codexAgentsState[idx][field] = String(value || '');
  }
  const count = document.getElementById('codex-agents-count');
  if (count) count.textContent = String(codexAgentsState.length);
}

function getCodexAgentsConfig() {
  const maxThreads = Number(document.getElementById('codex-agents-max-threads')?.value || 6);
  const maxDepth = Number(document.getElementById('codex-agents-max-depth')?.value || 1);
  const jobMaxRuntimeSeconds = Number(document.getElementById('codex-agents-job-timeout')?.value || 1800);
  return {
    maxThreads: Number.isInteger(maxThreads) && maxThreads > 0 ? maxThreads : 6,
    maxDepth: Number.isInteger(maxDepth) && maxDepth > 0 ? maxDepth : 1,
    jobMaxRuntimeSeconds: Number.isInteger(jobMaxRuntimeSeconds) && jobMaxRuntimeSeconds > 0 ? jobMaxRuntimeSeconds : 1800,
  };
}

function getCodexAgents() {
  return codexAgentsState.map(normalizeCodexAgent).filter(agent =>
    agent.name || agent.description || agent.developerInstructions
  );
}

function validateCodexAgents(agents, models) {
  const modelSet = new Set(models);
  const seen = new Set();
  const reserved = new Set(['default', 'worker', 'explorer']);
  for (const agent of agents) {
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(agent.name)) {
      return `子代理名称「${agent.name || '(空)'}」无效：必须匹配 ^[a-z][a-z0-9-]{0,63}$`;
    }
    if (reserved.has(agent.name)) return `子代理名称「${agent.name}」是 Codex 内置名称，当前版本不允许覆盖。`;
    const key = agent.name.toLowerCase();
    if (seen.has(key)) return `子代理名称重复：${agent.name}`;
    seen.add(key);
    if (!agent.description) return `子代理「${agent.name}」缺少描述。`;
    if (!agent.developerInstructions) return `子代理「${agent.name}」缺少 Developer Instructions。`;
    if (agent.model && !modelSet.has(agent.model)) return `子代理「${agent.name}」引用的模型「${agent.model}」不在当前模型列表中。`;
    if (agent.modelReasoningEffort && !['low', 'medium', 'high'].includes(agent.modelReasoningEffort)) {
      return `子代理「${agent.name}」的推理强度无效。`;
    }
    if (agent.sandboxMode && !['read-only', 'workspace-write', 'danger-full-access'].includes(agent.sandboxMode)) {
      return `子代理「${agent.name}」的 Sandbox 无效。`;
    }
    const nickSeen = new Set();
    for (const nickname of agent.nicknameCandidates) {
      if (!/^[A-Za-z0-9 _-]+$/.test(nickname)) {
        return `子代理「${agent.name}」的昵称「${nickname}」无效：仅允许 ASCII 字母、数字、空格、连字符和下划线。`;
      }
      const nickKey = nickname.toLowerCase();
      if (nickSeen.has(nickKey)) return `子代理「${agent.name}」的昵称重复：${nickname}`;
      nickSeen.add(nickKey);
    }
  }
  return '';
}

// ---- P3 globalThis mirror ----
(function mirrorFns(g) {
  g.syncCodexRawConfigFromFields = syncCodexRawConfigFromFields;
  g.renderCodexModelManager = renderCodexModelManager;
  g.getCodexModelEntries = getCodexModelEntries;
  g.setCodexModelEntriesState = setCodexModelEntriesState;
  g.toggleCodexModelCatalog = toggleCodexModelCatalog;
  g.cancelCodexModelEdit = cancelCodexModelEdit;
  g.selectCodexDefaultModel = selectCodexDefaultModel;
  g.addCodexModelEntry = addCodexModelEntry;
  g.editCodexModelEntry = editCodexModelEntry;
  g.saveCodexModelEdit = saveCodexModelEdit;
  g.removeCodexModelEntry = removeCodexModelEntry;
  g.batchSetCodexModelCatalog = batchSetCodexModelCatalog;
  g.batchSetCodexDefaultModel = batchSetCodexDefaultModel;
  g.codexConfigGetDefaultModel = codexConfigGetDefaultModel;
  g.codexConfigEndpointParts = codexConfigEndpointParts;
  g.fetchCodexConfigModels = fetchCodexConfigModels;
  g.codexConfigDisplayBaseUrl = codexConfigDisplayBaseUrl;
  g.codexConfigSetInputValue = codexConfigSetInputValue;
  g.renderReasoningConfig = renderReasoningConfig;
  g.getReasoningConfig = getReasoningConfig;
  g.codexAgentModelOptions = codexAgentModelOptions;
  g.normalizeCodexAgent = normalizeCodexAgent;
  g.renderCodexAgentsPanel = renderCodexAgentsPanel;
  g.addCodexAgent = addCodexAgent;
  g.removeCodexAgent = removeCodexAgent;
  g.updateCodexAgentField = updateCodexAgentField;
  g.getCodexAgentsConfig = getCodexAgentsConfig;
  g.getCodexAgents = getCodexAgents;
  g.validateCodexAgents = validateCodexAgents;
})(globalThis);
