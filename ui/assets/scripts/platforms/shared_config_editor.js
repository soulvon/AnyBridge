/**
 * platforms/shared_config_editor.js — Claude Code / Codex / OpenCode / Grok 通用配置编辑器共享层
 *
 * 收口能力：
 * 1. 添加页左侧供应商列表渲染与排序/筛选联动；
 * 2. 添加页右侧模型勾选列表与确认按钮计数同步；
 * 3. 拉取模型列表时的防竞态序号校验与标准动态 loading 态；
 * 4. sourceProviderId 实时连接视图解析与防旧快照反咬覆盖；
 * 5. 配置新增/编辑/删除的事务持久化（mutateProviderStore）与 UI 联动刷新。
 */

function _seTr(key, fallback, params) {
  if (typeof globalThis.t === 'function') {
    const out = globalThis.t(key, params);
    if (out && out !== key) return out;
  }
  if (!params) return fallback;
  return String(fallback).replace(/\{(\w+)\}/g, (m, k) => (
    Object.prototype.hasOwnProperty.call(params, k) ? params[k] : m
  ));
}

function setConfigFetchButtonLoading(btnOrId, loading, loadingText) {
  const btn = typeof btnOrId === 'string' ? document.getElementById(btnOrId) : btnOrId;
  if (!btn) return;
  const label = loadingText || _seTr('sharedEditor.fetchingModels', 'Fetching…');
  btn.classList?.toggle('is-loading', !!loading);
  if (loading) {
    if (typeof globalThis.setLoading === 'function') {
      globalThis.setLoading(btn, label);
    } else {
      if (btn.dataset && btn.dataset.prevHtml == null) btn.dataset.prevHtml = btn.innerHTML || btn.textContent || '';
      if ('disabled' in btn) btn.disabled = true;
      btn.innerHTML = typeof globalThis.loadingHtml === 'function' ? globalThis.loadingHtml(label) : label;
    }
    return;
  }
  if (typeof globalThis.clearLoading === 'function') {
    globalThis.clearLoading(btn);
  } else {
    if ('disabled' in btn) btn.disabled = false;
    if (btn.dataset && btn.dataset.prevHtml != null) {
      btn.innerHTML = btn.dataset.prevHtml;
      delete btn.dataset.prevHtml;
    }
  }
}

async function runRaceGuardedModelFetch({
  getSeq,
  bumpSeq,
  setLoadingFn,
  setStatusFn,
  loadingStatusText,
  fetcher,
  onSuccess,
  onError,
}) {
  const seq = typeof bumpSeq === 'function' ? bumpSeq() : 1;
  const isCurrent = () => (typeof getSeq === 'function' ? getSeq() === seq : true);

  if (typeof setLoadingFn === 'function') setLoadingFn(true);
  if (typeof setStatusFn === 'function' && loadingStatusText) {
    setStatusFn(loadingStatusText, 'loading');
  }

  try {
    const result = await fetcher(seq, isCurrent);
    if (!isCurrent()) return { stale: true, seq };
    if (typeof onSuccess === 'function') {
      await onSuccess(result, seq, isCurrent);
    }
    return { stale: false, seq, result };
  } catch (err) {
    if (!isCurrent()) return { stale: true, seq, error: err };
    if (typeof onError === 'function') {
      await onError(err, seq);
    }
    return { stale: false, seq, error: err };
  } finally {
    if (isCurrent() && typeof setLoadingFn === 'function') {
      setLoadingFn(false);
    }
  }
}

async function loadConfigEditorProviderModels() {
  let list = [];
  try {
    if (typeof globalThis.invoke === 'function') {
      list = (await globalThis.invoke('list_provider_models')) || [];
    }
  } catch (_) {
    list = [];
  }
  if (typeof globalThis.localProxyProviderModelsEntry === 'function') {
    const lp = globalThis.localProxyProviderModelsEntry();
    const isLp = typeof globalThis.isLocalProxyProviderEntry === 'function'
      ? globalThis.isLocalProxyProviderEntry
      : (p => p?.id === 'anybridge-local-proxy' || p?.providerId === 'anybridge-local-proxy');
    list = (Array.isArray(list) ? list : []).filter(p => !isLp(p));
    list.unshift(lp);
  }
  return Array.isArray(list) ? list : [];
}

function renderConfigAddProviderList({
  listId,
  sortPrefix,
  providers,
  keyword,
  selectedProviderId,
  selectAction,
}) {
  const list = document.getElementById(listId);
  if (typeof globalThis.syncPlatformAddSortControl === 'function') {
    globalThis.syncPlatformAddSortControl(sortPrefix);
  }
  if (!list) return;
  const all = Array.isArray(providers) ? providers : [];
  if (!all.length) {
    list.innerHTML = `<div class="cb-add-prov-empty">${_seTr('sharedEditor.noProviders', 'No providers yet. Add one on the Providers page.')}</div>`;
    return;
  }
  const filtered = typeof globalThis.platformAddVisibleProviders === 'function'
    ? globalThis.platformAddVisibleProviders(all, keyword)
    : all;
  if (!filtered.length) {
    list.innerHTML = `<div class="cb-add-prov-empty">${_seTr('sharedEditor.noMatchingProvider', 'No matching providers')}</div>`;
    return;
  }
  const esc = typeof globalThis.platformEsc === 'function' ? globalThis.platformEsc : (s => String(s || ''));
  const isBuiltinFn = typeof globalThis.isBuiltinProxyEntry === 'function' ? globalThis.isBuiltinProxyEntry : (() => false);
  const builtinTitle = _seTr('sharedEditor.builtinProviderTitle', 'AnyBridge Built-in Provider');
  const builtinTop = _seTr('sharedEditor.builtinTagTop', 'Built-in');
  const builtinBottom = _seTr('sharedEditor.builtinTagBottom', 'Proxy');

  list.innerHTML = filtered.map(p => {
    const initial = (p.providerName || '?').charAt(0).toUpperCase();
    const enabled = p.enabled !== false;
    const isActive = selectedProviderId === p.providerId;
    const isBuiltin = isBuiltinFn(p);
    const iconHtml = isBuiltin
      ? `<span class="cb-add-prov-icon cb-add-prov-icon-builtin" title="${esc(builtinTitle)}"><span>${esc(builtinTop)}</span><span>${esc(builtinBottom)}</span></span>`
      : `<span class="cb-add-prov-icon">${esc(initial)}</span>`;
    return `
      <div class="cb-add-prov-item ${isActive ? 'active' : ''} ${enabled ? '' : 'disabled'} ${isBuiltin ? 'is-local-proxy' : ''}" data-action="${esc(selectAction)}" data-arg="${esc(p.providerId)}">
        ${iconHtml}
        <span class="cb-add-prov-name">${esc(p.providerName)}</span>
        <span class="cb-add-prov-count">${Array.isArray(p.models) ? p.models.length : 0}</span>
      </div>
    `;
  }).join('');
}

function renderConfigAddModelChecklist({
  titleId,
  subId,
  bodyId,
  selectedProviderId,
  providers,
  platformLabel,
  preferredFamily = '',
  checkClass,
  updateAction,
  isChecked,
}) {
  const titleEl = document.getElementById(titleId);
  const subEl = document.getElementById(subId);
  const body = document.getElementById(bodyId);
  if (!body) return;

  const esc = typeof globalThis.platformEsc === 'function' ? globalThis.platformEsc : (s => String(s || ''));
  if (!selectedProviderId) {
    if (titleEl) titleEl.textContent = _seTr('sharedEditor.pickProviderTitle', 'Select a Provider');
    if (subEl) subEl.textContent = _seTr('sharedEditor.pickProviderSub', 'Select a provider on the left to browse its models');
    body.innerHTML = `<div class="cb-add-models-empty">${_seTr('sharedEditor.pickProviderEmpty', 'Select a provider from the left')}</div>`;
    return;
  }

  const provider = (Array.isArray(providers) ? providers : []).find(p => p.providerId === selectedProviderId);
  if (!provider) {
    if (titleEl) titleEl.textContent = _seTr('sharedEditor.providerNotFound', 'Provider Not Found');
    if (subEl) subEl.textContent = '';
    body.innerHTML = `<div class="cb-add-models-empty">${_seTr('sharedEditor.providerNotFound', 'Provider Not Found')}</div>`;
    return;
  }

  const models = Array.isArray(provider.models) ? provider.models : [];
  if (titleEl) titleEl.textContent = provider.providerName || '';
  if (subEl) {
    subEl.textContent = `${models.length} ${_seTr('sharedEditor.providerModelsMid', 'models · Select for ')}${platformLabel || ''}`;
  }

  if (!models.length) {
    body.innerHTML = `<div class="cb-add-models-empty">${_seTr('sharedEditor.noModelsInProvider', 'This provider has no models yet')}</div>`;
    return;
  }

  const sortFn = typeof globalThis.sortRoleSelectItems === 'function' ? globalThis.sortRoleSelectItems : (list => list);
  const sortedModels = sortFn(models, preferredFamily);
  const identityFn = typeof globalThis.cbAddModelIdentity === 'function'
    ? globalThis.cbAddModelIdentity
    : (id => `<span>${esc(id)}</span>`);

  body.innerHTML = sortedModels.map((m) => {
    const exists = typeof isChecked === 'function' ? !!isChecked(m, provider) : false;
    return `
      <label class="cb-add-model-row ${exists ? 'already-added' : ''}" data-existing="${exists ? 'true' : 'false'}">
        <input type="checkbox" class="${esc(checkClass)}" data-model-id="${esc(m.id)}" data-model-name="${esc(m.name || m.id)}" ${exists ? 'checked' : ''} data-action="cbOnAddModelCheckChanged" data-events="change" data-pass-this data-arg="${esc(updateAction)}">
        ${identityFn(m.id)}
      </label>
    `;
  }).join('');
}

function updateConfigAddConfirmButtonState(btnId, checkSelector) {
  const btn = document.getElementById(btnId);
  if (!btn) return;
  const checked = document.querySelectorAll(`${checkSelector}:checked`);
  btn.disabled = checked.length === 0;
  const label = btn.querySelector('.model-action-label');
  if (label) {
    const baseText = _seTr('sharedEditor.saveSelection', ' Save selection');
    label.textContent = checked.length > 0 ? `${baseText} (${checked.length})` : baseText;
  }
}

function resolveConfigEditorBoundView(cfg) {
  if (typeof globalThis.resolveBoundProviderView === 'function') {
    return globalThis.resolveBoundProviderView(cfg, globalThis.providerStore);
  }
  const item = cfg && typeof cfg === 'object' ? cfg : {};
  const providers = Array.isArray(globalThis.providerStore?.providers) ? globalThis.providerStore.providers : [];
  const sourceId = String(item.sourceProviderId || '').trim();
  const source = sourceId ? providers.find(p => p && p.id === sourceId) || null : null;
  return {
    source,
    hasSource: Boolean(source),
    sourceMissing: Boolean(sourceId && !source),
    sourceProviderId: sourceId,
    sourceProviderName: String(source?.name || item.sourceProviderName || item.name || '').trim(),
    apiHost: source ? String(source.apiHost || '') : String(item.apiHost || ''),
    apiPath: source ? String(source.apiPath || '') : String(item.apiPath || ''),
    apiKey: source ? String(source.apiKey || '') : String(item.apiKey || ''),
    enabled: source ? (item.enabled !== false && source.enabled !== false) : (item.enabled !== false),
  };
}

/**
 * 保存关联了 sourceProviderId 的配置时，优先采信主供应商的实时连接字段，
 * 避免编辑器内遗留的 settingsConfig.env / settingsConfig.options 旧快照反咬覆盖主供应商最新地址与密钥。
 */
function resolveBoundConnectionForSave({ sourceId, existing, baseUrl, apiKey, formatUrlFn }) {
  const effectiveSourceId = String(sourceId || existing?.sourceProviderId || '').trim();
  const view = effectiveSourceId
    ? resolveConfigEditorBoundView({ ...(existing || {}), sourceProviderId: effectiveSourceId })
    : { hasSource: false, source: null, apiHost: '', apiPath: '', apiKey: '' };
  if (!view.hasSource || !view.source) {
    return { bound: false, view, baseUrl, apiKey };
  }
  const resolvedBaseUrl = typeof formatUrlFn === 'function'
    ? (formatUrlFn(view) || baseUrl)
    : (typeof globalThis.platformJoinUrl === 'function'
        ? (globalThis.platformJoinUrl(view.apiHost, view.apiPath) || baseUrl)
        : (view.apiHost || baseUrl));
  const resolvedApiKey = String(view.apiKey || apiKey || '').trim();
  return {
    bound: true,
    view,
    baseUrl: resolvedBaseUrl,
    apiKey: resolvedApiKey,
  };
}

async function commitPlatformConfigMutation({
  mutator,
  renderList,
  alertOnError = false,
  onSuccess,
  onRollback,
}) {
  const rerenderAll = async () => {
    if (typeof globalThis.renderProviders === 'function') globalThis.renderProviders();
    if (typeof globalThis.renderEvalProviderOptions === 'function') globalThis.renderEvalProviderOptions();
    if (typeof globalThis.renderModelMap === 'function') await globalThis.renderModelMap();
    if (typeof renderList === 'function') renderList();
    if (typeof globalThis.renderPlatformProviderOptions === 'function') globalThis.renderPlatformProviderOptions();
  };

  let ok = false;
  if (typeof globalThis.mutateProviderStore === 'function') {
    ok = await globalThis.mutateProviderStore(mutator, {
      alertOnError,
      onRollback: async err => {
        if (typeof renderList === 'function') renderList();
        if (typeof onRollback === 'function') await onRollback(err);
      },
    });
  } else {
    const res = await mutator(globalThis.providerStore);
    if (res === false) return false;
    ok = typeof globalThis.persistProviders === 'function' ? await globalThis.persistProviders() : true;
  }

  if (!ok) return false;
  await rerenderAll();
  if (typeof onSuccess === 'function') await onSuccess();
  return true;
}

(function mirrorFns(g) {
  g.setConfigFetchButtonLoading = setConfigFetchButtonLoading;
  g.runRaceGuardedModelFetch = runRaceGuardedModelFetch;
  g.loadConfigEditorProviderModels = loadConfigEditorProviderModels;
  g.renderConfigAddProviderList = renderConfigAddProviderList;
  g.renderConfigAddModelChecklist = renderConfigAddModelChecklist;
  g.updateConfigAddConfirmButtonState = updateConfigAddConfirmButtonState;
  g.resolveConfigEditorBoundView = resolveConfigEditorBoundView;
  g.resolveBoundConnectionForSave = resolveBoundConnectionForSave;
  g.commitPlatformConfigMutation = commitPlatformConfigMutation;
})(globalThis);
