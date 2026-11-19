// model-picker/editor-test-and-fetch.js — 供应商编辑器内置连通性测试与模型目录拉取

const EDITOR_RESULT_BAR_ICONS = {
  success: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path><polyline points="22 4 12 14.01 9 11.01"></polyline></svg>',
  error: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="15" y1="9" x2="9" y2="15"></line><line x1="9" y1="9" x2="15" y2="15"></line></svg>'
};

// 会话判据：离开编辑器页后到达的结论不写入结果区（防止切页回来残留旧结论）
function isProviderEditorPageActive() {
  return document.getElementById('page-provider-editor')?.classList.contains('active') === true;
}

// Vertex AI（Express Key）没有模型列表接口：请求只会拿到上游 HTML 404 页。
// 识别这类端点后禁用「获取模型列表」并常驻一行说明，模型走模板预置或手动添加。
function isVertexModelListEndpoint(host, apiPath) {
  const text = `${host || ''} ${apiPath || ''}`.toLowerCase();
  return text.includes('aiplatform.googleapis.com') || text.includes('/publishers/google/models');
}

globalThis.syncVertexModelListHint = function () {
  const host = document.getElementById('pf-host')?.value || '';
  const path = document.getElementById('pf-path')?.value || '';
  const btn = document.getElementById('pf-fetch-btn');
  const vertex = isVertexModelListEndpoint(host, path);
  if (btn) {
    btn.disabled = vertex;
    btn.title = vertex ? '该供应商不支持在线拉取模型列表，模型已在模板中预置' : '获取模型列表';
  }
  let hint = document.getElementById('pf-vertex-list-hint');
  if (!vertex) {
    if (hint) hint.hidden = true;
    return;
  }
  if (!hint) {
    hint = document.createElement('div');
    hint.id = 'pf-vertex-list-hint';
    hint.style.cssText = 'font-size:12px; color:var(--text-secondary); margin:8px 16px 0; line-height:1.5;';
    const header = document.querySelector('#modelPanel .model-panel-header');
    if (header) header.insertAdjacentElement('afterend', hint);
  }
  hint.textContent = 'Vertex AI 没有在线模型列表接口：模型已在模板中预置，也可以手动添加模型 ID。';
  hint.hidden = false;
};

// 结论写入结果条并持续保留，直到下次操作覆盖或离开页面清除；文案复用既有结论原文
function setEditorResultBar(type, message, boxId) {
  const box = document.getElementById(boxId);
  if (!box) return;
  const isSuccess = type === 'success';
  box.classList.remove('is-success', 'is-error');
  box.classList.add(isSuccess ? 'is-success' : 'is-error');
  const icon = document.createElement('span');
  icon.className = 'result-icon';
  icon.innerHTML = EDITOR_RESULT_BAR_ICONS[isSuccess ? 'success' : 'error'];
  const text = document.createElement('span');
  text.className = 'result-text';
  text.textContent = String(message || '');
  box.innerHTML = '';
  box.appendChild(icon);
  box.appendChild(text);
  box.hidden = false;
  if (isSuccess) {
    if (typeof markErrorProtected === 'function') markErrorProtected(box, 0);
  } else if (typeof markErrorProtected === 'function') {
    markErrorProtected(box, 10000);
  }
}

function clearEditorResultBar(boxId, options = {}) {
  const box = document.getElementById(boxId);
  if (!box) return;
  if (!options.force && typeof isErrorProtected === 'function' && isErrorProtected(box)) {
    return;
  }
  if (typeof markErrorProtected === 'function') markErrorProtected(box, 0);
  box.hidden = true;
  box.classList.remove('is-success', 'is-error');
  box.innerHTML = '';
}

async function testProviderInEditor() {
  if (!invoke) {
    showProviderEditorTestToast('应用通道未就绪，无法测试连接', 'error');
    addLog('err', '连接测试失败: Tauri 通道未就绪');
    return;
  }
  const baseUrl = document.getElementById('pf-host').value.trim();
  const apiKey = document.getElementById('pf-key').value.trim();
  const fmt = document.getElementById('pf-format').value;
  const apiPath = document.getElementById('pf-path').value || '';
  const model = String(selectedModels[0] || '').trim() || null;
  if (!baseUrl || !apiKey) {
    showProviderEditorTestToast('请先填写 API 地址和密钥', 'warn');
    addLog('warn', '请先填写 API 地址和密钥');
    return;
  }
  if (!model) {
    showProviderEditorTestToast('请先选择一个模型作为测试目标', 'warn');
    addLog('warn', '请先选择一个模型作为测试目标');
    return;
  }

  const endpoint = providerEndpointParts(baseUrl, fmt, apiPath || null);

  setProviderEditorTestButtonState(true);
  showProviderEditorTestToast(`正在测试 ${model}...`, 'info', { duration: 1400 });
  try {
    const result = await invoke('test_connection', {
      args: { host: endpoint.apiHost, api_key: apiKey, path: endpoint.apiPath || null, api_format: fmt, model }
    });
    const msg = typeof result === 'string' ? result : (result.message || '连通 ✓');
    // 自动同步 gzip 能力标记
    if (result && typeof result === 'object' && result.capabilities) {
      const c = result.capabilities;
      const gzipEl = document.getElementById('pf-cap-gzip');
      if (gzipEl && c.gzip !== undefined) gzipEl.checked = c.gzip;
    }
    if (isProviderEditorPageActive()) setEditorResultBar('success', `连接测试通过：${msg}`, 'providerEditorTestResult');
    showProviderEditorTestToast(`连接测试通过：${msg}`, 'success', { duration: 3200 });
    addLog('ok', '连接测试: ' + msg);
  } catch (e) {
    const message = String(e) || '失败';
    if (isProviderEditorPageActive()) setEditorResultBar('error', `连接测试失败：${message}`, 'providerEditorTestResult');
    if (typeof showCustomAlert === 'function') {
      showCustomAlert(message, '连接测试失败', 'error');
    } else {
      showProviderEditorTestToast(`连接测试失败：${message}`, 'error', { duration: 4200 });
    }
    addLog('err', '连接测试失败: ' + e);
  } finally {
    setProviderEditorTestButtonState(false);
  }
}

// ─── 弹窗内拉取模型列表 ──────────────────────────────────────────
async function fetchModelsForEditor(options = {}) {
  if (!invoke) return;
  const baseUrl = document.getElementById('pf-host').value.trim();
  const apiKey = document.getElementById('pf-key').value.trim();
  const apiPath = document.getElementById('pf-path').value || '';
  const fmtEl = document.getElementById('pf-format');
  const primaryFmt = fmtEl ? fmtEl.value : 'anthropic';
  const btn = document.getElementById('pf-fetch-btn');
  const isBackground = !!options.background;
  if (!baseUrl || !apiKey) {
    addLog('warn', '请先填写 API 地址和密钥');
    return;
  }
  if (isVertexModelListEndpoint(baseUrl, apiPath)) {
    if (typeof globalThis.syncVertexModelListHint === 'function') globalThis.syncVertexModelListHint();
    showProviderEditorTestToast('该供应商不支持在线拉取模型列表，模型已在模板中预置，也可手动添加', 'warn', { duration: 2600 });
    return;
  }
  if (btn?.dataset.loading === '1') return;
  // 计算尝试顺序：先按当前协议；如失败回退到另一种协议
  const lockedFormat = fmtEl?.dataset?.locked === '1';
  const formatsToTry = lockedFormat
    ? [primaryFmt]
    : (primaryFmt === 'gemini'
      ? ['gemini', 'openai', 'anthropic']
      : (primaryFmt === 'openai' ? ['openai', 'anthropic', 'gemini'] : ['anthropic', 'openai', 'gemini']));
  const fmtLabel = (f) => f === 'gemini' ? 'Gemini' : (f === 'openai' ? 'OpenAI' : 'Anthropic');

  let succeeded = null;
  let lastError = null;
  for (let i = 0; i < formatsToTry.length; i++) {
    const tryFmt = formatsToTry[i];
    if (btn) {
      btn.dataset.loading = '1';
      btn.disabled = true;
      btn.innerHTML = providerFetchButtonContent(isBackground
        ? `同步 ${fmtLabel(tryFmt)} 模型…`
        : `用 ${fmtLabel(tryFmt)} 协议拉取中…`, true);
    }
    if (i > 0) {
      addLog('info', `尝试用 ${fmtLabel(tryFmt)} 协议重新拉取…`);
    } else {
      addLog('info', `开始用 ${fmtLabel(tryFmt)} 协议拉取模型列表…`);
    }
    try {
      const endpoint = providerEndpointParts(baseUrl, tryFmt, apiPath || null);
      const result = await invoke('fetch_models', {
        args: {
          host: endpoint.apiHost,
          api_key: apiKey,
          api_format: tryFmt,
          path: endpoint.apiPath || null,
        }
      });
      if (result.models && result.models.length > 0) {
        succeeded = { fmt: tryFmt, models: result.models };
        break;
      } else {
        lastError = new Error(`${fmtLabel(tryFmt)} 协议返回的模型列表为空`);
      }
    } catch (e) {
      lastError = e;
    }
  }

  try {
    if (succeeded) {
      activeModelsList = Array.from(new Set([...selectedModels, ...succeeded.models]));
      if (typeof sortModelsNaturally === 'function') {
        activeModelsList = sortModelsNaturally(activeModelsList);
      }

      // 拉取成功：把下拉/select 同步到真正命中的协议，并锁定（避免下次输入 URL 又被覆盖）
      if (fmtEl) {
        fmtEl.value = succeeded.fmt;
        fmtEl.dataset.locked = '1';
        if (typeof onFormatChange === 'function') onFormatChange();
      }

      // Auto fill first model if empty
      const modelInput = document.getElementById('pf-model');
      if (modelInput && !modelInput.value) {
        selectModel(succeeded.models[0]);
      }

      modelGroupStates = {};
      filterModelPanel();
      if (isProviderEditorPageActive()) setEditorResultBar('success', `获取到 ${succeeded.models.length} 个模型`, 'providerFetchResult');
      addLog('ok', `✅ 用 ${fmtLabel(succeeded.fmt)} 协议成功拉取到 ${succeeded.models.length} 个模型`);
    } else {
      throw lastError || new Error('未知错误');
    }
  } catch (e) {
    // No more default preset list overrides - strictly show what is configured
    addLog('warn', `线上拉取失败 (${e})。你可检查配置、或使用底部输入框手动添加自定义模型 ID。`);
    if (isProviderEditorPageActive()) setEditorResultBar('error', `拉取失败：${String(e)}`, 'providerFetchResult');
    // Keep local selections visible; a transient remote failure should not make saved models disappear.
    const modelInput = document.getElementById('pf-model');
    const modelVal = modelInput ? modelInput.value : '';
    activeModelsList = Array.from(new Set([...selectedModels, modelVal].filter(Boolean)));
    modelGroupStates = {};
    filterModelPanel();
    // 失败原因直接写在模型面板上 —— 之前只进扩展中心日志，用户在编辑页
    // 只看到「暂无模型」，根本不知道是服务没起还是密钥不对。
    const failBody = document.getElementById('modelPanelBody');
    if (failBody) {
      const line = document.createElement('div');
      line.className = 'model-panel-empty';
      line.style.color = 'var(--danger, #dc2626)';
      line.textContent = `拉取失败：${String(e)}`;
      failBody.replaceChildren(line);
    }
  } finally {
    if (btn) {
      btn.dataset.loading = '0';
      btn.disabled = false;
      btn.innerHTML = providerFetchButtonContent('获取模型列表');
    }
  }
}

// ---- P3 globalThis mirror ----
(function mirrorFns(g) {
  g.setEditorResultBar = setEditorResultBar;
  g.clearEditorResultBar = clearEditorResultBar;
  g.testProviderInEditor = testProviderInEditor;
  g.fetchModelsForEditor = fetchModelsForEditor;
})(globalThis);
