// platforms/antigravity_enhance.js — Antigravity 与 Antigravity IDE 独立增强插件弹窗
// 两款客户端拥有完全独立的弹窗容器、状态槽、执行日志、站内 GitHub 详情视图与上游源码卡片。

function createAppEnhanceState() {
  return {
    items: [],
    locStatus: null,
    cdpStatus: null,
    locUpdateInfo: null,
    expandedIntros: new Set(),
    activeDetailId: null,
    detailCache: new Map(),
    detailLoading: false,
    detailError: '',
    detailSeq: 0,
    logExpanded: false,
    busy: false,
    loadSeq: 0
  };
}

const _enhanceStates = { antigravity: createAppEnhanceState(), 'antigravity-ide': createAppEnhanceState() };
let _enhanceEntrySeq = 0;

function normalizeEnhanceApp(app) { return app === 'antigravity-ide' ? 'antigravity-ide' : 'antigravity'; }
function appCfg(appId) { return ENHANCE_APPS[normalizeEnhanceApp(appId)]; }
function appState(appId) { return _enhanceStates[normalizeEnhanceApp(appId)]; }

function resolveEnhanceApp(triggerEl, appArg = null) {
  if (appArg === 'antigravity' || appArg === 'antigravity-ide') return appArg;
  if (triggerEl === 'antigravity' || triggerEl === 'antigravity-ide') return triggerEl;
  const hostApp = triggerEl?.closest?.('[data-enhance-app]')?.getAttribute?.('data-enhance-app');
  if (hostApp === 'antigravity' || hostApp === 'antigravity-ide') return hostApp;
  return normalizeEnhanceApp(typeof getAntigravityTarget === 'function' ? getAntigravityTarget() : 'antigravity');
}

function et(key, params) {
  return typeof t === 'function' ? t(key, params) : key;
}

function setEnhanceLogExpanded(appId, expanded) {
  const id = normalizeEnhanceApp(appId);
  const state = appState(id);
  const cfg = appCfg(id);
  state.logExpanded = Boolean(expanded);
  const drawer = document.getElementById(cfg.logDrawerId);
  const box = document.getElementById(cfg.logId);
  const toggleBtn = drawer?.querySelector?.('.antigravity-enhance-log-toggle');
  if (drawer) drawer.classList.toggle('is-open', state.logExpanded);
  if (box) box.hidden = !state.logExpanded;
  if (toggleBtn) toggleBtn.setAttribute('aria-expanded', String(state.logExpanded));
}

function toggleAntigravityEnhanceLog(triggerOrApp = null, appArg = null) {
  const id = resolveEnhanceApp(triggerOrApp, appArg);
  setEnhanceLogExpanded(id, !appState(id).logExpanded);
}

function appendAntigravityEnhanceLog(text, level = 'info', appId = null) {
  const id = normalizeEnhanceApp(appId);
  const cfg = appCfg(id);
  const box = document.getElementById(cfg.logId);
  const preview = document.getElementById(cfg.logPreviewId);
  const [prefixKey, color] = ENHANCE_LOG_META[level] || ENHANCE_LOG_META.info;
  const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  const firstLine = String(text || '').split(/\r?\n/).find((l) => l.trim()) || '';
  if (preview) {
    preview.textContent = firstLine ? `[${time}] ${firstLine}` : et('agEnhance.logReady');
    preview.classList.remove('is-ok', 'is-warn', 'is-err');
    if (level === 'ok' || level === 'warn' || level === 'err') preview.classList.add(`is-${level}`);
  }
  if (!box) return;
  const line = document.createElement('div');
  line.textContent = `[${time}] ${et(prefixKey)} ${text}`;
  if (color) line.style.color = color;
  box.appendChild(line);
  box.scrollTop = box.scrollHeight;
  if (level === 'err') setEnhanceLogExpanded(id, true);
}

function clearAntigravityEnhanceLog(appArg = null) {
  const id = resolveEnhanceApp(null, appArg);
  const cfg = appCfg(id);
  const box = document.getElementById(cfg.logId);
  const preview = document.getElementById(cfg.logPreviewId);
  if (box) box.textContent = '';
  if (preview) {
    preview.textContent = et('agEnhance.logReady');
    preview.classList.remove('is-ok', 'is-warn', 'is-err');
  }
}

function setAntigravityEnhanceBusy(appId, busy, activeBtn = null) {
  const id = normalizeEnhanceApp(appId);
  appState(id).busy = busy;
  const selector = `#${appCfg(id).modalId} button, #${ENHANCE_DETAIL_MODAL_ID}[data-enhance-app="${id}"] button`;
  document.querySelectorAll(selector).forEach((btn) => {
    if (btn.classList.contains('antigravity-enhance-close')
      || btn.classList.contains('antigravity-enhance-log-clear')
      || btn.classList.contains('antigravity-enhance-log-toggle')
      || btn.classList.contains('enhance-detail-close')
      || btn.classList.contains('enhance-detail-open-external')) {
      return;
    }
    if (btn === activeBtn) return;
    if (busy) {
      if (btn.dataset.prevDisabled == null) btn.dataset.prevDisabled = btn.disabled ? '1' : '0';
      btn.disabled = true;
    } else if (btn.dataset.prevDisabled != null) {
      btn.disabled = btn.dataset.prevDisabled === '1';
      delete btn.dataset.prevDisabled;
    } else {
      btn.disabled = false;
    }
  });
}

async function executeEnhanceAction(appId, {
  triggerEl, loadingKey, startText, failTitleKey, toastInsteadOfAlert = false, run
}) {
  const id = normalizeEnhanceApp(appId);
  if (appState(id).busy || typeof invoke !== 'function') return;
  const btn = triggerEl && typeof triggerEl.querySelectorAll === 'function' ? triggerEl : null;
  if (btn && typeof setLoading === 'function') setLoading(btn, et(loadingKey));
  setAntigravityEnhanceBusy(id, true, btn);
  try {
    if (startText) appendAntigravityEnhanceLog(startText, 'info', id);
    try {
      return await run();
    } catch (err) {
      const message = String(err?.message || err);
      appendAntigravityEnhanceLog(
        toastInsteadOfAlert ? `${et('agEnhance.checkUpdateFailed')}${message}` : message,
        toastInsteadOfAlert ? 'warn' : 'err',
        id
      );
      if (toastInsteadOfAlert && typeof showBottomToast === 'function') {
        showBottomToast(`${et('agEnhance.checkUpdateFailed')}${message}`, 'error');
      } else if (!toastInsteadOfAlert && typeof showCustomAlert === 'function') {
        showCustomAlert(message, et(failTitleKey), 'error');
      }
    }
  } finally {
    if (btn && typeof clearLoading === 'function') clearLoading(btn);
    setAntigravityEnhanceBusy(id, false, btn);
  }
}

function antigravityEnhanceBadge(text, tone) {
  const cls = tone === 'ok' ? 'ok' : tone === 'warn' ? 'warn' : tone === 'bad' ? 'bad' : '';
  return `<span class="enhance-badge ${cls}">${enhanceEscape(text)}</span>`;
}

function toggleAntigravityEnhanceIntro(triggerOrId, cardId) {
  const isLegacyCall = typeof triggerOrId === 'string';
  const id = isLegacyCall ? triggerOrId : cardId;
  const appId = resolveEnhanceApp(isLegacyCall ? null : triggerOrId);
  if (!id) return;
  const state = appState(appId);
  if (state.expandedIntros.has(id)) state.expandedIntros.delete(id);
  else state.expandedIntros.add(id);
  renderAntigravityEnhanceCards(appId);
}

function buildMetaLineHtml(items) {
  if (!items || !items.length) return '';
  return `<div class="enhance-meta-line">${items.map((item) => `
    <span class="enhance-meta-entry">
      <span class="enhance-meta-label">${enhanceEscape(item.label)}</span>
      <span class="enhance-meta-val" title="${enhanceEscape(item.value)}">${enhanceEscape(item.value)}</span>
      ${item.pill ? `<span class="enhance-update-pill">${enhanceEscape(item.pill)}</span>` : ''}
    </span>`).join('<span class="enhance-meta-sep" aria-hidden="true"></span>')}</div>`;
}

function antigravityEnhanceCard(appId, {
  id, icon = 'extension', tone = 'muted', title, badge, desc,
  tags = [], metaItems = [], introItems = [], scopeNote = '', conflictHtml = '', detail = '', repo = '', actions = ''
}) {
  const expanded = appState(appId).expandedIntros.has(id);
  const titleHtml = repo
    ? `<button type="button" class="enhance-card-title-btn" data-action="openAntigravityEnhanceDetail" data-arg="${enhanceEscape(id)}" data-pass-this title="${enhanceEscape(et('agEnhance.viewDetailTitle'))}">${enhanceEscape(title)}</button>`
    : `<h3 class="enhance-card-title">${enhanceEscape(title)}</h3>`;
  const leftBtn = repo
    ? `<button type="button" class="enhance-repo-btn" data-action="openAntigravityEnhanceDetail" data-arg="${enhanceEscape(id)}" data-pass-this>${antigravityEnhanceIcon('github', 13)}<span>${enhanceEscape(et('agEnhance.viewDetailBtn'))}</span></button>`
    : (introItems.length
      ? `<button type="button" class="enhance-repo-btn${expanded ? ' is-open' : ''}" data-action="toggleAntigravityEnhanceIntro" data-arg="${enhanceEscape(id)}" data-pass-this aria-expanded="${String(expanded)}"><span>${enhanceEscape(et('agEnhance.introToggle'))}</span>${antigravityEnhanceIcon('chevron', 13)}</button>`
      : '');
  const introHtml = !repo && expanded && introItems.length
    ? `<div class="enhance-card-intro"><ul>${introItems.map((line) => `<li>${enhanceEscape(line)}</li>`).join('')}</ul></div>`
    : '';

  return `
    <article class="enhance-card${detail ? ' has-issue' : ''}">
      <div class="enhance-card-main">
        <div class="enhance-card-head">
          <div class="enhance-card-icon tone-${tone}">${antigravityEnhanceIcon(icon, 18)}</div>
          <div class="enhance-card-head-body">
            <div class="enhance-card-title-row">
              ${titleHtml}
              ${badge ? antigravityEnhanceBadge(badge, tone) : ''}
            </div>
            <p class="enhance-card-desc">${enhanceEscape(desc)}</p>
          </div>
        </div>
        ${tags.length ? `<div class="enhance-card-tags">${tags.map((tag) => `<span class="enhance-tag">${enhanceEscape(tag)}</span>`).join('')}</div>` : ''}
        ${buildMetaLineHtml(metaItems)}
        ${scopeNote ? `<div class="enhance-card-scope-note">${enhanceEscape(scopeNote)}</div>` : ''}
        ${conflictHtml}
        ${introHtml}
        ${detail ? `<div class="enhance-card-detail">${enhanceEscape(detail)}</div>` : ''}
      </div>
      <div class="enhance-card-actions">
        <div class="enhance-card-actions-left">${leftBtn}</div>
        <div class="enhance-card-actions-main">${actions}</div>
      </div>
    </article>`;
}

function buildLocalizationActionsHtml(installed, localized) {
  return [
    `<button type="button" class="btn-primary" data-action="applyAntigravityEnhanceLocalization" data-pass-this${!installed ? ' disabled' : ''}>${enhanceEscape(localized ? et('agEnhance.locReapply') : et('agEnhance.locApply'))}</button>`,
    `<button type="button" class="btn-ghost secondary" data-action="checkAntigravityEnhanceLocUpdate" data-pass-this>${enhanceEscape(et('agEnhance.locUpdateBtn'))}</button>`,
    localized
      ? `<button type="button" class="btn-ghost danger" data-action="restoreAntigravityEnhanceLocalization" data-pass-this>${enhanceEscape(et('agEnhance.locRestore'))}</button>`
      : ''
  ].join('');
}

function buildLocalizationCardHtml(appId) {
  const isHub = normalizeEnhanceApp(appId) !== 'antigravity-ide';
  const state = appState(appId);
  const locStatus = state.locStatus;
  const localized = Boolean(locStatus?.localized);
  const installed = locStatus ? Boolean(locStatus.installed) : true;
  const ver = locStatus?.currentVersion ? `v${locStatus.currentVersion}` : et('agEnhance.builtinDict');
  const hasLocUpdate = Boolean(state.locUpdateInfo?.hasUpdate);
  const tone = !installed ? 'bad' : localized ? 'ok' : (hasLocUpdate ? 'warn' : 'muted');
  const badge = !installed
    ? et('agEnhance.hostMissingBadge')
    : localized ? et('agEnhance.localized') : et('agEnhance.unlocalized');

  return antigravityEnhanceCard(appId, {
    id: 'antigravity-localization',
    icon: 'lang',
    tone,
    title: et('agEnhance.locProjectName'),
    badge,
    desc: isHub ? et('agEnhance.locHubDesc') : et('agEnhance.locIdeDesc'),
    tags: [et('agEnhance.tagBuiltinDict'), et('agEnhance.tagOffline'), isHub ? et('agEnhance.tagDesktop') : et('agEnhance.tagIdeUi')],
    metaItems: [
      { label: et('agEnhance.locKvDictLabel'), value: ver, pill: hasLocUpdate ? et('agEnhance.updateAvailablePill') : '' },
      isHub
        ? { label: et('agEnhance.locKvModeLabel'), value: et('agEnhance.locModeHub') }
        : { label: et('agEnhance.locKvLangPackLabel'), value: locStatus?.langPackInstalled ? et('agEnhance.langPackReady') : et('agEnhance.langPackMissing') }
    ],
    introItems: [et('agEnhance.locIntro1'), et('agEnhance.locIntro2'), isHub ? et('agEnhance.locIntro3Hub') : et('agEnhance.locIntro3Ide')],
    detail: !installed ? et('agEnhance.locHostNotFound') : '',
    repo: LOC_UPSTREAM_REPO,
    actions: buildLocalizationActionsHtml(installed, localized)
  });
}

function buildItemActionsHtml(item) {
  const installed = Boolean(item.installed);
  const compatible = item.compatible !== false;
  const hasUpdate = Boolean(item.hasUpdate && item.latestVersion);
  let primaryLabel = et('agEnhance.install');
  if (installed && hasUpdate) primaryLabel = `${et('agEnhance.updateToPrefix')}v${item.latestVersion}`;
  else if (installed) primaryLabel = et('agEnhance.reinstall');

  return [
    compatible
      ? `<button type="button" class="btn-primary" data-action="installAntigravityEnhance" data-arg="${enhanceEscape(item.id)}" data-pass-this>${enhanceEscape(primaryLabel)}</button>`
      : `<button type="button" class="btn-primary" disabled title="${enhanceEscape(et('agEnhance.incompatibleTitle'))}">${enhanceEscape(et('agEnhance.unavailable'))}</button>`,
    `<button type="button" class="btn-ghost secondary" data-action="checkAntigravityEnhanceUpdate" data-arg="${enhanceEscape(item.id)}" data-pass-this>${enhanceEscape(et('agEnhance.checkUpdateBtn'))}</button>`,
    installed
      ? `<button type="button" class="btn-ghost danger" data-action="uninstallAntigravityEnhance" data-arg="${enhanceEscape(item.id)}" data-pass-this>${enhanceEscape(et('agEnhance.uninstall'))}</button>`
      : ''
  ].join('');
}

function buildEnhanceItemCardHtml(appId, item) {
  const catalog = ANTIGRAVITY_ENHANCE_CATALOG[item.id] || {};
  const installed = Boolean(item.installed);
  const compatible = item.compatible !== false;
  const hasUpdate = Boolean(item.hasUpdate && item.latestVersion);
  const tone = !compatible ? 'bad' : hasUpdate ? 'warn' : installed ? 'ok' : 'muted';
  const badge = !compatible
    ? et('agEnhance.hostMissingBadge')
    : hasUpdate ? et('agEnhance.hasUpdateBadge') : (installed ? et('agEnhance.installed') : et('agEnhance.notInstalled'));

  const verText = item.version ? `v${item.version}` : et('agEnhance.fetchLatestShort');
  const hostText = item.hostInstalled
    ? (item.hostVersion ? `Antigravity v${item.hostVersion}` : et('agEnhance.hostDesktopDetected'))
    : et('agEnhance.hostMissingBadge');

  return antigravityEnhanceCard(appId, {
    id: item.id,
    icon: catalog.icon || 'extension',
    tone,
    title: item.name || catalog.repo?.split('/').pop() || item.id,
    badge,
    desc: (catalog.descKey ? et(catalog.descKey) : '') || item.description || '',
    tags: (catalog.tagKeys || []).map((k) => et(k)),
    metaItems: [
      { label: et('agEnhance.kvPluginVersion'), value: verText, pill: hasUpdate ? `v${item.latestVersion}` : '' },
      { label: et('agEnhance.kvHostTarget'), value: hostText }
    ],
    conflictHtml: buildEnhanceConflictCalloutsHtml(appState(appId).items, item, et, 'compact'),
    introItems: (catalog.introKeys || []).map((k) => et(k)),
    detail: item.detail || '',
    repo: item.repo || catalog.repo || '',
    actions: buildItemActionsHtml(item)
  });
}

function buildIdeCdpCardHtml(appId) {
  const state = appState(appId);
  const ideInstalled = state.locStatus ? Boolean(state.locStatus.installed) : true;
  const cdpStatus = state.cdpStatus;
  const available = Boolean(cdpStatus?.available);
  const targets = Number(cdpStatus?.targets || 0);
  const injected = Number(cdpStatus?.injected || 0);
  const allDone = available && targets > 0 && injected >= targets;
  const tone = !ideInstalled ? 'bad' : allDone ? 'ok' : available ? 'warn' : 'muted';
  const badge = !ideInstalled
    ? et('agEnhance.hostMissingBadge')
    : !available ? et('agEnhance.cdpNotReady')
      : allDone ? et('agEnhance.cdpInjected') : (targets > 0 ? et('agEnhance.cdpPending') : et('agEnhance.cdpReady'));
  const hint = cdpStatus?.message
    || (available ? `${et('agEnhance.cdpActivePrefix')}${injected}/${targets}${et('agEnhance.cdpActiveSuffix')}` : et('agEnhance.cdpInactiveHint'));

  return antigravityEnhanceCard(appId, {
    id: 'antigravity-ide-cdp',
    icon: 'dashboard',
    tone,
    title: et('agEnhance.cdpCardTitle'),
    badge,
    desc: et('agEnhance.cdpCardDesc'),
    tags: [et('agEnhance.tagCdpRuntime'), et('agEnhance.tagIdeUi'), et('agEnhance.tagAutoReinject')],
    metaItems: [
      { label: et('agEnhance.cdpKvChannelLabel'), value: available ? et('agEnhance.cdpChannelOpen') : et('agEnhance.cdpChannelClosed') },
      { label: et('agEnhance.cdpKvWindowsLabel'), value: available ? `${injected}/${targets}` : et('agEnhance.cdpWindowsNone') }
    ],
    scopeNote: ideInstalled ? hint : '',
    introItems: [et('agEnhance.cdpIntro1'), et('agEnhance.cdpIntro2'), et('agEnhance.cdpIntro3')],
    detail: !ideInstalled ? et('agEnhance.locHostNotFound') : '',
    actions: [
      `<button type="button" class="btn-primary" data-action="handleAntigravityEnhanceCdpAction" data-pass-this${!ideInstalled ? ' disabled' : ''}>${enhanceEscape(available ? et('agEnhance.cdpInjectNow') : et('agEnhance.cdpRestartIde'))}</button>`,
      `<button type="button" class="btn-ghost secondary" data-action="refreshAntigravityEnhance" data-arg="antigravity-ide" data-pass-this>${enhanceEscape(et('agEnhance.cdpRefreshBtn'))}</button>`
    ].join('')
  });
}

function renderAntigravityEnhanceCards(appId) {
  const id = normalizeEnhanceApp(appId);
  const list = document.getElementById(appCfg(id).listId);
  if (!list) return;
  const state = appState(id);
  const cards = id === 'antigravity-ide'
    ? [buildLocalizationCardHtml(id), buildIdeCdpCardHtml(id)]
    : (state.items || []).map((item) => buildEnhanceItemCardHtml(id, item));
  const isSingle = cards.length === 1;
  list.classList.toggle('is-single', isSingle);
  list.closest('.antigravity-enhance-modal')?.classList.toggle('is-single', isSingle);
  list.innerHTML = cards.join('');
  if (state.activeDetailId) renderActiveEnhanceDetail(id);
}

async function fetchLocalizationStatusForTarget(target) {
  if (typeof invoke !== 'function') return null;
  if (target === 'antigravity-ide') {
    return invoke('get_app_localization_status', { platform: 'antigravity-ide' }).catch(() => null);
  }
  return invoke('get_antigravity_localization_status', { target }).catch(() => null);
}

async function syncAntigravityEnhanceEntryButton() {
  if (typeof invoke !== 'function') return;
  const btn = document.getElementById('antigravityEnhanceBtn');
  const countEl = document.getElementById('antigravityEnhanceCount');
  if (!btn) return;
  const seq = ++_enhanceEntrySeq;
  const target = typeof getAntigravityTarget === 'function' ? normalizeEnhanceApp(getAntigravityTarget()) : 'antigravity';
  const isIde = target === 'antigravity-ide';
  try {
    let enabled = 0;
    if (isIde) {
      const [locStatus, cdpStatus] = await Promise.all([
        fetchLocalizationStatusForTarget(target),
        invoke('get_antigravity_cdp_status').catch(() => null)
      ]);
      if (seq !== _enhanceEntrySeq) return;
      if (locStatus?.localized) enabled += 1;
      const targets = Number(cdpStatus?.targets || 0);
      const injected = Number(cdpStatus?.injected || 0);
      if (cdpStatus?.available && targets > 0 && injected >= targets) enabled += 1;
    } else {
      const items = await invoke('get_antigravity_enhance_status').catch(() => []);
      if (seq !== _enhanceEntrySeq) return;
      for (const item of items || []) {
        if (item?.installed) enabled += 1;
      }
    }
    if (countEl) {
      countEl.textContent = enabled > 0 ? String(enabled) : '';
      countEl.hidden = enabled === 0;
    }
    btn.classList.toggle('is-active', enabled > 0);
  } catch (_) {}
}

async function loadAntigravityEnhanceData(appId) {
  const id = normalizeEnhanceApp(appId);
  const state = appState(id);
  const seq = ++state.loadSeq;
  const isIde = id === 'antigravity-ide';
  const [items, locStatus, cdpStatus] = await Promise.all([
    isIde ? Promise.resolve([]) : invoke('get_antigravity_enhance_status'),
    isIde ? fetchLocalizationStatusForTarget(id) : Promise.resolve(null),
    isIde ? invoke('get_antigravity_cdp_status').catch(() => null) : Promise.resolve(null)
  ]);
  if (seq !== state.loadSeq) return;
  state.items = Array.isArray(items) ? items : [];
  state.locStatus = locStatus;
  state.cdpStatus = cdpStatus;
  renderAntigravityEnhanceCards(id);
  void syncAntigravityEnhanceEntryButton();
}

async function refreshAntigravityEnhance(triggerOrApp = null, appArg = null) {
  const id = resolveEnhanceApp(triggerOrApp, appArg);
  const list = document.getElementById(appCfg(id).listId);
  if (!list || typeof invoke !== 'function') return;
  const hasExistingCards = Boolean(list.querySelector('.enhance-card'));
  if (!hasExistingCards) {
    const label = enhanceEscape(et('agEnhance.detecting'));
    const html = typeof loadingHtml === 'function' ? loadingHtml(label, 14) : label;
    list.innerHTML = `<div class="enhance-loading-state">${html}</div>`;
  }
  const btn = triggerOrApp && typeof triggerOrApp.querySelectorAll === 'function' ? triggerOrApp : null;
  if (btn && typeof setLoading === 'function') setLoading(btn, et('agEnhance.refreshing'));
  try {
    await loadAntigravityEnhanceData(id);
  } catch (err) {
    const msg = `${et('agEnhance.detectFailed')}${err?.message || err}`;
    if (!hasExistingCards) {
      list.innerHTML = `<div class="enhance-error-state">${enhanceEscape(msg)}</div>`;
    }
    appendAntigravityEnhanceLog(String(err?.message || err), 'err', id);
  } finally {
    if (btn && typeof clearLoading === 'function') clearLoading(btn);
  }
}

async function openEnhanceModalForApp(appId) {
  const id = normalizeEnhanceApp(appId);
  const otherId = id === 'antigravity-ide' ? 'antigravity' : 'antigravity-ide';
  document.getElementById(appCfg(otherId).modalId)?.classList.remove('active');
  const modal = document.getElementById(appCfg(id).modalId);
  if (!modal) return;
  closeAntigravityEnhanceDetail(id);
  setEnhanceLogExpanded(id, false);
  modal.classList.add('active');
  clearAntigravityEnhanceLog(id);
  appendAntigravityEnhanceLog(et('agEnhance.modalOpened'), 'info', id);
  await refreshAntigravityEnhance(document.getElementById(appCfg(id).refreshBtnId), id);
}

function closeEnhanceModalForApp(appId) {
  const id = normalizeEnhanceApp(appId);
  closeAntigravityEnhanceDetail(id);
  document.getElementById(appCfg(id).modalId)?.classList.remove('active');
}

const openAntigravityEnhanceModal = () => openEnhanceModalForApp('antigravity');
const closeAntigravityEnhanceModal = () => closeEnhanceModalForApp('antigravity');
const openAntigravityIdeEnhanceModal = () => openEnhanceModalForApp('antigravity-ide');
const closeAntigravityIdeEnhanceModal = () => closeEnhanceModalForApp('antigravity-ide');

async function openAntigravityEnhanceRepo(triggerOrRepo, repoMaybe = null) {
  const repo = typeof triggerOrRepo === 'string' ? triggerOrRepo : repoMaybe;
  if (!repo) return;
  const appId = typeof triggerOrRepo === 'string' ? null : resolveEnhanceApp(triggerOrRepo);
  const url = /^https?:\/\//i.test(repo) ? repo : `https://github.com/${repo}`;
  try {
    if (typeof invoke === 'function') {
      await invoke('open_url', { url });
      return;
    }
  } catch (err) {
    appendAntigravityEnhanceLog(`${et('agEnhance.openRepoFailed')}${err?.message || err}`, 'warn', appId);
  }
  window.open(url, '_blank');
}

async function promptRestartAfterEnhanceChange(promptKey, appId) {
  if (typeof confirmRestartAntigravityClient === 'function') {
    const restarted = await confirmRestartAntigravityClient(et(promptKey), appId);
    if (restarted) {
      closeEnhanceModalForApp(appId);
      return true;
    }
    return false;
  }
  appendAntigravityEnhanceLog(et('agEnhance.locRestartHint'), 'warn', appId);
  return false;
}

async function confirmAndRunPackageAction(triggerEl, id, opts) {
  const itemId = typeof triggerEl === 'string' ? triggerEl : id;
  const btn = typeof triggerEl === 'string' ? null : triggerEl;
  const appId = resolveEnhanceApp(btn, 'antigravity');
  if (!itemId || typeof invoke !== 'function') return;
  const confirmMessage = opts.confirmText || et(opts.confirmKey);
  const confirmed = typeof showCustomConfirm === 'function'
    ? await showCustomConfirm(confirmMessage, et(opts.confirmTitleKey), 'warn')
    : true;
  if (!confirmed) return;

  await executeEnhanceAction(appId, {
    triggerEl: btn,
    loadingKey: opts.loadingKey,
    startText: `${et(opts.startKey)}${itemId}`,
    failTitleKey: opts.failTitleKey,
    run: async () => {
      const output = await invoke(opts.command, opts.buildPayload(itemId));
      if (output) appendAntigravityEnhanceLog(output.trim(), 'ok', appId);
      appendAntigravityEnhanceLog(et(opts.doneKey), 'ok', appId);
      if (typeof showBottomToast === 'function') showBottomToast(et(opts.toastKey), 'success');
      await loadAntigravityEnhanceData(appId);
      await promptRestartAfterEnhanceChange(opts.restartKey, appId);
    }
  });
}

function installAntigravityEnhance(triggerEl, id) {
  const itemId = typeof triggerEl === 'string' ? triggerEl : id;
  const items = appState('antigravity').items || [];
  const item = items.find((x) => x.id === itemId) || { id: itemId };
  return confirmAndRunPackageAction(triggerEl, id, {
    confirmText: buildEnhanceInstallConfirmText(items, item, et),
    confirmKey: getBaseInstallConfirmKey(itemId),
    confirmTitleKey: 'agEnhance.installTitle',
    loadingKey: 'agEnhance.installing',
    startKey: 'agEnhance.installStart',
    failTitleKey: 'agEnhance.installFailTitle',
    command: 'install_antigravity_enhance',
    buildPayload: (argId) => ({ id: argId, forceUpdate: Boolean(item?.hasUpdate) }),
    doneKey: 'agEnhance.installDone',
    toastKey: 'agEnhance.installToast',
    restartKey: 'agEnhance.installRestartPrompt'
  });
}

function uninstallAntigravityEnhance(triggerEl, id) {
  const itemId = typeof triggerEl === 'string' ? triggerEl : id;
  return confirmAndRunPackageAction(triggerEl, id, {
    confirmKey: getBaseUninstallConfirmKey(itemId),
    confirmTitleKey: 'agEnhance.uninstallTitle',
    loadingKey: 'agEnhance.uninstalling',
    startKey: 'agEnhance.uninstallStart',
    failTitleKey: 'agEnhance.uninstallFailTitle',
    command: 'uninstall_antigravity_enhance',
    buildPayload: (argId) => ({ id: argId }),
    doneKey: 'agEnhance.uninstallDone',
    toastKey: 'agEnhance.uninstallToast',
    restartKey: 'agEnhance.uninstallRestartPrompt'
  });
}

async function checkAntigravityEnhanceUpdateCore(appId, itemId, silentToast = false) {
  const info = await invoke('check_antigravity_enhance_update', { id: itemId });
  const msg = info?.hasUpdate
    ? `${et('agEnhance.pluginUpdateFoundPrefix')}v${info.latestVersion}`
    : `${et('agEnhance.pluginUpToDatePrefix')}v${info?.latestVersion || '-'}`;
  appendAntigravityEnhanceLog(msg, 'ok', appId);
  if (!silentToast && typeof showBottomToast === 'function') {
    showBottomToast(msg, info?.hasUpdate ? 'success' : 'info');
  }
  return info;
}

async function checkAntigravityEnhanceUpdate(triggerEl, id) {
  const itemId = typeof triggerEl === 'string' ? triggerEl : id;
  const btn = typeof triggerEl === 'string' ? null : triggerEl;
  const appId = resolveEnhanceApp(btn, 'antigravity');
  if (!itemId) return;

  await executeEnhanceAction(appId, {
    triggerEl: btn,
    loadingKey: 'agEnhance.checkingUpdate',
    startText: et('agEnhance.checkingPluginUpdate'),
    toastInsteadOfAlert: true,
    run: async () => {
      await checkAntigravityEnhanceUpdateCore(appId, itemId, false);
      await loadAntigravityEnhanceData(appId);
    }
  });
}

async function checkLocUpdateCore(appId, silentToast = false) {
  const isIde = appId === 'antigravity-ide';
  const info = isIde
    ? await invoke('check_app_localization_update', { platform: 'antigravity-ide' })
    : await invoke('check_antigravity_localization_update');
  appState(appId).locUpdateInfo = info || null;
  if (info?.hasUpdate) {
    appendAntigravityEnhanceLog(et('agEnhance.locDownloading'), 'ok', appId);
    const dl = isIde
      ? await invoke('download_app_localization_update', { platform: 'antigravity-ide' })
      : await invoke('download_antigravity_localization_update');
    appendAntigravityEnhanceLog(dl?.message || et('agEnhance.locDownloadedHint'), 'ok', appId);
    if (!silentToast && typeof showBottomToast === 'function') {
      showBottomToast(et('agEnhance.locDownloadedHint'), 'success');
    }
  } else {
    const msg = `${et('agEnhance.locUpToDatePrefix')} (${info?.currentVersion || 'baseline'})`;
    appendAntigravityEnhanceLog(msg, 'ok', appId);
    if (!silentToast && typeof showBottomToast === 'function') showBottomToast(msg, 'info');
  }
  return info;
}

async function checkAntigravityEnhanceLocUpdate(triggerEl) {
  const appId = resolveEnhanceApp(triggerEl);
  await executeEnhanceAction(appId, {
    triggerEl,
    loadingKey: 'agEnhance.checkingUpdate',
    startText: et('agEnhance.checkingLocUpdate'),
    toastInsteadOfAlert: true,
    run: async () => {
      await checkLocUpdateCore(appId, false);
      await loadAntigravityEnhanceData(appId);
    }
  });
}

async function checkAllAntigravityEnhanceUpdates(triggerEl, appArg = null) {
  const appId = resolveEnhanceApp(triggerEl, appArg);
  const isIde = appId === 'antigravity-ide';
  await executeEnhanceAction(appId, {
    triggerEl,
    loadingKey: 'agEnhance.checkingUpdate',
    startText: et(isIde ? 'agEnhance.checkingIdeUpdates' : 'agEnhance.checkingAllUpdates'),
    toastInsteadOfAlert: true,
    run: async () => {
      let anyUpdate = false;
      if (isIde) {
        try {
          const info = await checkLocUpdateCore(appId, true);
          anyUpdate = Boolean(info?.hasUpdate);
        } catch (err) {
          appendAntigravityEnhanceLog(`${et('agEnhance.locCheckSkipped')}${err?.message || err}`, 'warn', appId);
        }
      } else {
        const listed = (appState(appId).items || []).map((x) => x.id).filter(Boolean);
        const ids = listed.length ? listed : Object.keys(ANTIGRAVITY_ENHANCE_CATALOG);
        for (const itemId of ids) {
          try {
            const info = await checkAntigravityEnhanceUpdateCore(appId, itemId, true);
            anyUpdate = anyUpdate || Boolean(info?.hasUpdate);
          } catch (err) {
            appendAntigravityEnhanceLog(`${itemId}${et('agEnhance.checkOneSkipped')}${err?.message || err}`, 'warn', appId);
          }
        }
      }
      await loadAntigravityEnhanceData(appId);
      if (typeof showBottomToast === 'function') {
        showBottomToast(et(anyUpdate ? 'agEnhance.allCheckHasUpdateToast' : 'agEnhance.allCheckLatestToast'), anyUpdate ? 'success' : 'info');
      }
    }
  });
}

async function waitForAntigravityCdp(attempts, intervalMs) {
  for (let i = 0; i < attempts; i += 1) {
    await new Promise((r) => setTimeout(r, intervalMs));
    const st = await invoke('get_antigravity_cdp_status').catch(() => null);
    if (st?.available) return true;
  }
  return false;
}

async function applyCdpAndSync(appId) {
  const res = await invoke('apply_antigravity_cdp_localization');
  appState(appId).cdpStatus = res;
  appendAntigravityEnhanceLog(res?.message || et('agEnhance.cdpInjectDone'), 'ok', appId);
  renderAntigravityEnhanceCards(appId);
  void syncAntigravityEnhanceEntryButton();
}

async function runEnhanceLocalizationAction(triggerEl, restore) {
  const appId = resolveEnhanceApp(triggerEl);
  const isIde = appId === 'antigravity-ide';
  const cmd = restore
    ? (isIde ? 'restore_app_localization' : 'restore_antigravity_localization')
    : (isIde ? 'apply_app_localization' : 'apply_antigravity_localization');
  await executeEnhanceAction(appId, {
    triggerEl,
    loadingKey: restore ? 'agEnhance.restoringLoc' : 'agEnhance.applyingLoc',
    startText: et(restore ? 'agEnhance.locRestoring' : 'agEnhance.locApplying'),
    failTitleKey: restore ? 'agEnhance.locRestoreFailTitle' : 'agEnhance.locFailTitle',
    run: async () => {
      const res = await invoke(cmd, isIde ? { platform: 'antigravity-ide' } : { target: appId });
      if (!restore) appState(appId).locUpdateInfo = null;
      const fbKey = restore ? 'agEnhance.locRestoredFallback' : 'agEnhance.locAppliedFallback';
      appendAntigravityEnhanceLog(res?.message || et(fbKey), 'ok', appId);
      await loadAntigravityEnhanceData(appId);
      const promptKey = restore ? 'agEnhance.locRestoredPrompt' : 'agEnhance.locAppliedPrompt';
      const restarted = await promptRestartAfterEnhanceChange(promptKey, appId);
      if (!restore && restarted && isIde) {
        void waitForAntigravityCdp(8, 1500).then((ok) => ok && invoke('apply_antigravity_cdp_localization').catch(() => null));
      }
    }
  });
}

const applyAntigravityEnhanceLocalization = (el) => runEnhanceLocalizationAction(el, false);
const restoreAntigravityEnhanceLocalization = (el) => runEnhanceLocalizationAction(el, true);

async function handleAntigravityEnhanceCdpAction(triggerEl) {
  if (typeof invoke !== 'function') return;
  const appId = resolveEnhanceApp(triggerEl, 'antigravity-ide');
  const st = await invoke('get_antigravity_cdp_status').catch(() => null);
  if (st?.available) {
    await executeEnhanceAction(appId, {
      triggerEl,
      loadingKey: 'agEnhance.cdpInjecting',
      failTitleKey: 'agEnhance.cdpFailTitle',
      run: () => applyCdpAndSync(appId)
    });
    return;
  }

  const confirmed = typeof showCustomConfirm === 'function'
    ? await showCustomConfirm(et('agEnhance.cdpRestartConfirm'), et('agEnhance.cdpRestartTitle'), 'warn')
    : true;
  if (!confirmed) return;

  await executeEnhanceAction(appId, {
    triggerEl,
    loadingKey: 'agEnhance.cdpRestarting',
    startText: et('agEnhance.cdpRestartLog'),
    failTitleKey: 'agEnhance.cdpFailTitle',
    run: async () => {
      const msg = await invoke('restart_antigravity_ide_with_cdp');
      appendAntigravityEnhanceLog(msg || et('agEnhance.cdpRestartedWait'), 'ok', appId);
      if (!(await waitForAntigravityCdp(15, 2000))) {
        appendAntigravityEnhanceLog(et('agEnhance.cdpTimeoutWarn'), 'warn', appId);
        await loadAntigravityEnhanceData(appId);
        return;
      }
      await applyCdpAndSync(appId);
    }
  });
}

// ---- P3 globalThis mirror ----
Object.assign(globalThis, {
  normalizeEnhanceApp, appCfg, appState, resolveEnhanceApp, et,
  buildLocalizationActionsHtml, buildItemActionsHtml,
  appendAntigravityEnhanceLog, clearAntigravityEnhanceLog, toggleAntigravityEnhanceLog,
  syncAntigravityEnhanceEntryButton,
  openAntigravityEnhanceModal, closeAntigravityEnhanceModal,
  openAntigravityIdeEnhanceModal, closeAntigravityIdeEnhanceModal,
  refreshAntigravityEnhance, toggleAntigravityEnhanceIntro, openAntigravityEnhanceRepo,
  installAntigravityEnhance, uninstallAntigravityEnhance, checkAntigravityEnhanceUpdate,
  checkAntigravityEnhanceLocUpdate, checkAllAntigravityEnhanceUpdates,
  applyAntigravityEnhanceLocalization, restoreAntigravityEnhanceLocalization,
  handleAntigravityEnhanceCdpAction
});
