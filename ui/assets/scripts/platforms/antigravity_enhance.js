// platforms/antigravity_enhance.js — Antigravity 与 Antigravity IDE 独立增强插件弹窗
// 两款客户端拥有完全独立的弹窗容器、状态槽、执行日志与上游源码卡片。

const LOC_UPSTREAM_REPO = 'liominsb/Antigravity-Chinese-Localization';

const ANTIGRAVITY_ENHANCE_CATALOG = {
  'antigravity-context-viewer': {
    icon: 'dashboard',
    repo: 'elviscjn-cjn/antigravity-context-viewer',
    tagKeys: ['agEnhance.tagTopbar', 'agEnhance.tagBuiltinHans', 'agEnhance.tagMultiAccount', 'agEnhance.tagTimeline'],
    descKey: 'agEnhance.viewerDesc',
    introKeys: ['agEnhance.viewerIntro1', 'agEnhance.viewerIntroHans', 'agEnhance.viewerIntro2', 'agEnhance.viewerIntro3']
  }
};

const ENHANCE_APPS = {
  antigravity: { modalId: 'antigravityEnhanceModal', listId: 'antigravityEnhanceList', logId: 'antigravityEnhanceLog', refreshBtnId: 'antigravityEnhanceRefreshBtn' },
  'antigravity-ide': { modalId: 'antigravityIdeEnhanceModal', listId: 'antigravityIdeEnhanceList', logId: 'antigravityIdeEnhanceLog', refreshBtnId: 'antigravityIdeEnhanceRefreshBtn' }
};

const ANTIGRAVITY_ENHANCE_ICONS = {
  extension:
    '<path d="M20.5 11H19V7c0-1.1-.9-2-2-2h-4V3.5C13 2.12 11.88 1 10.5 1S8 2.12 8 3.5V5H4c-1.1 0-1.99.9-1.99 2v3.8H3.5c1.49 0 2.7 1.21 2.7 2.7s-1.21 2.7-2.7 2.7H2V20c0 1.1.9 2 2 2h3.8v-1.5c0-1.49 1.21-2.7 2.7-2.7 1.49 0 2.7 1.21 2.7 2.7V22H17c1.1 0 2-.9 2-2v-4h1.5c1.38 0 2.5-1.12 2.5-2.5S21.88 11 20.5 11z"/>',
  lang:
    '<path d="m5 8 6 6"/><path d="m4 14 6-6 2-3"/><path d="M2 5h12"/><path d="M7 2h1"/><path d="m22 22-5-10-5 10"/><path d="M14 18h6"/>',
  dashboard:
    '<rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/>',
  external:
    '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>',
  chevron:
    '<polyline points="6 9 12 15 18 9"/>'
};

function createAppEnhanceState() {
  return { items: [], locStatus: null, cdpStatus: null, locUpdateInfo: null, expandedIntros: new Set(), busy: false, loadSeq: 0 };
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

function enhanceEscape(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[ch]));
}

function antigravityEnhanceIcon(name, size = 20, filled = false) {
  const body = ANTIGRAVITY_ENHANCE_ICONS[name] || ANTIGRAVITY_ENHANCE_ICONS.extension;
  if (filled) {
    return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">${body}</svg>`;
  }
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
}

function appendAntigravityEnhanceLog(text, level = 'info', appId = null) {
  const box = document.getElementById(appCfg(appId).logId);
  if (!box) return;
  const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  const prefix = level === 'ok'
    ? et('agEnhance.logOk')
    : level === 'warn'
      ? et('agEnhance.logWarn')
      : level === 'err'
        ? et('agEnhance.logErr')
        : et('agEnhance.logInfo');
  const line = document.createElement('div');
  line.textContent = `[${time}] ${prefix} ${text}`;
  if (level === 'ok') line.style.color = 'var(--success)';
  else if (level === 'warn') line.style.color = 'var(--accent-warm)';
  else if (level === 'err') line.style.color = 'var(--danger)';
  box.appendChild(line);
  box.scrollTop = box.scrollHeight;
}

function clearAntigravityEnhanceLog(appArg = null) {
  const box = document.getElementById(appCfg(resolveEnhanceApp(null, appArg)).logId);
  if (box) box.textContent = '';
}

function setAntigravityEnhanceBusy(appId, busy, activeBtn = null) {
  const id = normalizeEnhanceApp(appId);
  appState(id).busy = busy;
  document.querySelectorAll(`#${appCfg(id).modalId} button`).forEach((btn) => {
    if (btn.classList.contains('antigravity-enhance-close') || btn.classList.contains('antigravity-enhance-log-clear')) {
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

function buildKvGridHtml(rows) {
  if (!rows || !rows.length) return '';
  return `<div class="enhance-kv-grid">${rows.map((row) => `
    <div class="enhance-kv-item">
      <span class="enhance-kv-label">${enhanceEscape(row.label)}</span>
      <div class="enhance-kv-value-row">
        <span class="enhance-kv-value" title="${enhanceEscape(row.value)}">${enhanceEscape(row.value)}</span>
        ${row.pill ? `<span class="enhance-update-pill">${enhanceEscape(row.pill)}</span>` : ''}
      </div>
    </div>`).join('')}</div>`;
}

function antigravityEnhanceCard(appId, {
  id, icon = 'extension', tone = 'muted', title, badge, desc,
  tags = [], kvRows = [], introItems = [], scopeNote = '', detail = '', repo = '', actions = ''
}) {
  const expanded = appState(appId).expandedIntros.has(id);
  const introToggle = introItems.length
    ? `<button type="button" class="enhance-intro-toggle${expanded ? ' is-open' : ''}" data-action="toggleAntigravityEnhanceIntro" data-arg="${enhanceEscape(id)}" data-pass-this aria-expanded="${String(expanded)}"><span>${enhanceEscape(et('agEnhance.introToggle'))}</span>${antigravityEnhanceIcon('chevron', 13)}</button>`
    : '';
  const introHtml = expanded && introItems.length
    ? `<div class="enhance-card-intro"><ul>${introItems.map((line) => `<li>${enhanceEscape(line)}</li>`).join('')}</ul></div>`
    : '';
  const repoButton = repo
    ? `<button type="button" class="enhance-repo-btn" data-action="openAntigravityEnhanceRepo" data-arg="${enhanceEscape(repo)}">${antigravityEnhanceIcon('external', 13)}<span>${enhanceEscape(et('agEnhance.githubRepo'))}</span></button>`
    : '';
  return `
    <article class="enhance-card${detail ? ' has-issue' : ''}">
      <div class="enhance-card-main">
        <div class="enhance-card-head">
          <div class="enhance-card-icon tone-${tone}">${antigravityEnhanceIcon(icon, 22, icon === 'extension')}</div>
          <div class="enhance-card-content">
            <div class="enhance-card-title-row">
              <div class="enhance-card-title-group">
                <h3 class="enhance-card-title">${enhanceEscape(title)}</h3>
                ${badge ? antigravityEnhanceBadge(badge, tone) : ''}
              </div>
              ${introToggle}
            </div>
            <p class="enhance-card-desc">${enhanceEscape(desc)}</p>
          </div>
        </div>
        ${tags.length ? `<div class="enhance-card-tags">${tags.map((tag) => `<span class="enhance-tag">${enhanceEscape(tag)}</span>`).join('')}</div>` : ''}
        ${buildKvGridHtml(kvRows)}
        ${scopeNote ? `<div class="enhance-card-scope-note">${enhanceEscape(scopeNote)}</div>` : ''}
        ${introHtml}
        ${detail ? `<div class="enhance-card-detail">${enhanceEscape(detail)}</div>` : ''}
      </div>
      <div class="enhance-card-actions">
        <div class="enhance-card-actions-left">${repoButton}</div>
        <div class="enhance-card-actions-main">${actions}</div>
      </div>
    </article>`;
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
    : localized
      ? et('agEnhance.localized')
      : et('agEnhance.unlocalized');

  const kvRows = [
    { label: et('agEnhance.locKvDictLabel'), value: ver, pill: hasLocUpdate ? et('agEnhance.updateAvailablePill') : '' },
    isHub
      ? { label: et('agEnhance.locKvModeLabel'), value: et('agEnhance.locModeHub') }
      : { label: et('agEnhance.locKvLangPackLabel'), value: locStatus?.langPackInstalled ? et('agEnhance.langPackReady') : et('agEnhance.langPackMissing') }
  ];

  const actions = [
    `<button type="button" class="btn-primary" data-action="applyAntigravityEnhanceLocalization" data-pass-this${!installed ? ' disabled' : ''}>${enhanceEscape(localized ? et('agEnhance.locReapply') : et('agEnhance.locApply'))}</button>`,
    `<button type="button" class="btn-ghost secondary" data-action="checkAntigravityEnhanceLocUpdate" data-pass-this>${enhanceEscape(et('agEnhance.locUpdateBtn'))}</button>`,
    localized
      ? `<button type="button" class="btn-ghost danger" data-action="restoreAntigravityEnhanceLocalization" data-pass-this>${enhanceEscape(et('agEnhance.locRestore'))}</button>`
      : ''
  ].join('');

  return antigravityEnhanceCard(appId, {
    id: 'antigravity-localization',
    icon: 'lang',
    tone,
    title: et('agEnhance.locProjectName'),
    badge,
    desc: isHub ? et('agEnhance.locHubDesc') : et('agEnhance.locIdeDesc'),
    tags: [et('agEnhance.tagBuiltinDict'), et('agEnhance.tagOffline'), isHub ? et('agEnhance.tagDesktop') : et('agEnhance.tagIdeUi')],
    kvRows,
    introItems: [et('agEnhance.locIntro1'), et('agEnhance.locIntro2'), isHub ? et('agEnhance.locIntro3Hub') : et('agEnhance.locIntro3Ide')],
    detail: !installed ? et('agEnhance.locHostNotFound') : '',
    repo: LOC_UPSTREAM_REPO,
    actions
  });
}

function buildContextViewerCardHtml(appId, item) {
  const catalog = ANTIGRAVITY_ENHANCE_CATALOG[item.id] || {};
  const installed = Boolean(item.installed);
  const compatible = item.compatible !== false;
  const hasUpdate = Boolean(item.hasUpdate && item.latestVersion);
  const tone = !compatible ? 'bad' : hasUpdate ? 'warn' : installed ? 'ok' : 'muted';
  const badge = !compatible
    ? et('agEnhance.hostMissingBadge')
    : hasUpdate
      ? et('agEnhance.hasUpdateBadge')
      : installed ? et('agEnhance.installed') : et('agEnhance.notInstalled');

  const verText = item.version ? `v${item.version}` : et('agEnhance.fetchLatestOnInstall');
  const hostText = item.hostInstalled
    ? (item.hostVersion ? `Antigravity v${item.hostVersion}` : et('agEnhance.hostDesktopDetected'))
    : et('agEnhance.hostMissingBadge');

  let primaryLabel = et('agEnhance.install');
  if (installed && hasUpdate) primaryLabel = `${et('agEnhance.updateToPrefix')}v${item.latestVersion}`;
  else if (installed) primaryLabel = et('agEnhance.reinstall');

  const actions = [
    compatible
      ? `<button type="button" class="btn-primary" data-action="installAntigravityEnhance" data-arg="${enhanceEscape(item.id)}" data-pass-this>${enhanceEscape(primaryLabel)}</button>`
      : `<button type="button" class="btn-primary" disabled title="${enhanceEscape(et('agEnhance.incompatibleTitle'))}">${enhanceEscape(et('agEnhance.unavailable'))}</button>`,
    `<button type="button" class="btn-ghost secondary" data-action="checkAntigravityEnhanceUpdate" data-arg="${enhanceEscape(item.id)}" data-pass-this>${enhanceEscape(et('agEnhance.checkUpdateBtn'))}</button>`,
    installed
      ? `<button type="button" class="btn-ghost danger" data-action="uninstallAntigravityEnhance" data-arg="${enhanceEscape(item.id)}" data-pass-this>${enhanceEscape(et('agEnhance.uninstall'))}</button>`
      : ''
  ].join('');

  return antigravityEnhanceCard(appId, {
    id: item.id,
    icon: catalog.icon || 'extension',
    tone,
    title: item.name || et('agEnhance.viewerTitleFallback'),
    badge,
    desc: item.description || (catalog.descKey ? et(catalog.descKey) : ''),
    tags: (catalog.tagKeys || []).map((k) => et(k)),
    kvRows: [
      { label: et('agEnhance.kvPluginVersion'), value: verText, pill: hasUpdate ? `v${item.latestVersion}` : '' },
      { label: et('agEnhance.kvHostTarget'), value: hostText }
    ],
    introItems: (catalog.introKeys || []).map((k) => et(k)),
    detail: item.detail || '',
    repo: item.repo || catalog.repo || '',
    actions
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
    : !available
      ? et('agEnhance.cdpNotReady')
      : allDone ? et('agEnhance.cdpInjected') : (targets > 0 ? et('agEnhance.cdpPending') : et('agEnhance.cdpReady'));
  const hint = cdpStatus?.message
    || (available ? `${et('agEnhance.cdpActivePrefix')}${injected}/${targets}${et('agEnhance.cdpActiveSuffix')}` : et('agEnhance.cdpInactiveHint'));
  const btnLabel = available ? et('agEnhance.cdpInjectNow') : et('agEnhance.cdpRestartIde');
  return antigravityEnhanceCard(appId, {
    id: 'antigravity-ide-cdp',
    icon: 'dashboard',
    tone,
    title: et('agEnhance.cdpCardTitle'),
    badge,
    desc: et('agEnhance.cdpCardDesc'),
    tags: [et('agEnhance.tagCdpRuntime'), et('agEnhance.tagIdeUi'), et('agEnhance.tagAutoReinject')],
    kvRows: [
      { label: et('agEnhance.cdpKvChannelLabel'), value: available ? et('agEnhance.cdpChannelOpen') : et('agEnhance.cdpChannelClosed') },
      { label: et('agEnhance.cdpKvWindowsLabel'), value: available ? `${injected}/${targets}` : et('agEnhance.cdpWindowsNone') }
    ],
    scopeNote: ideInstalled ? hint : '',
    introItems: [et('agEnhance.cdpIntro1'), et('agEnhance.cdpIntro2'), et('agEnhance.cdpIntro3')],
    detail: !ideInstalled ? et('agEnhance.locHostNotFound') : '',
    actions: [
      `<button type="button" class="btn-primary" data-action="handleAntigravityEnhanceCdpAction" data-pass-this${!ideInstalled ? ' disabled' : ''}>${enhanceEscape(btnLabel)}</button>`,
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
    : (state.items || []).map((item) => buildContextViewerCardHtml(id, item));
  const isSingle = cards.length === 1;
  list.classList.toggle('is-single', isSingle);
  list.closest('.antigravity-enhance-modal')?.classList.toggle('is-single', isSingle);
  list.innerHTML = cards.join('');
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
  modal.classList.add('active');
  clearAntigravityEnhanceLog(id);
  appendAntigravityEnhanceLog(et('agEnhance.modalOpened'), 'info', id);
  await refreshAntigravityEnhance(document.getElementById(appCfg(id).refreshBtnId), id);
}

function closeEnhanceModalForApp(appId) {
  document.getElementById(appCfg(appId).modalId)?.classList.remove('active');
}

function openAntigravityEnhanceModal() {
  return openEnhanceModalForApp('antigravity');
}

function closeAntigravityEnhanceModal() {
  closeEnhanceModalForApp('antigravity');
}

function openAntigravityIdeEnhanceModal() {
  return openEnhanceModalForApp('antigravity-ide');
}

function closeAntigravityIdeEnhanceModal() {
  closeEnhanceModalForApp('antigravity-ide');
}

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
  const confirmed = typeof showCustomConfirm === 'function'
    ? await showCustomConfirm(et(opts.confirmKey), et(opts.confirmTitleKey), 'warn')
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
  const item = (appState('antigravity').items || []).find((x) => x.id === itemId);
  return confirmAndRunPackageAction(triggerEl, id, {
    confirmKey: 'agEnhance.installConfirm',
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
  return confirmAndRunPackageAction(triggerEl, id, {
    confirmKey: 'agEnhance.uninstallConfirm',
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
      let info = null;
      try {
        info = isIde
          ? await checkLocUpdateCore(appId, true)
          : await checkAntigravityEnhanceUpdateCore(appId, 'antigravity-context-viewer', true);
      } catch (err) {
        const prefixKey = isIde ? 'agEnhance.locCheckSkipped' : 'agEnhance.pluginCheckFailed';
        appendAntigravityEnhanceLog(`${et(prefixKey)}${err?.message || err}`, 'warn', appId);
      }
      await loadAntigravityEnhanceData(appId);
      if (typeof showBottomToast === 'function') {
        const anyUpdate = Boolean(info?.hasUpdate);
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

function applyAntigravityEnhanceLocalization(triggerEl) {
  return runEnhanceLocalizationAction(triggerEl, false);
}

function restoreAntigravityEnhanceLocalization(triggerEl) {
  return runEnhanceLocalizationAction(triggerEl, true);
}

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
  appendAntigravityEnhanceLog, clearAntigravityEnhanceLog, syncAntigravityEnhanceEntryButton,
  openAntigravityEnhanceModal, closeAntigravityEnhanceModal,
  openAntigravityIdeEnhanceModal, closeAntigravityIdeEnhanceModal,
  refreshAntigravityEnhance, toggleAntigravityEnhanceIntro, openAntigravityEnhanceRepo,
  installAntigravityEnhance, uninstallAntigravityEnhance, checkAntigravityEnhanceUpdate,
  checkAntigravityEnhanceLocUpdate, checkAllAntigravityEnhanceUpdates,
  applyAntigravityEnhanceLocalization, restoreAntigravityEnhanceLocalization,
  handleAntigravityEnhanceCdpAction
});
