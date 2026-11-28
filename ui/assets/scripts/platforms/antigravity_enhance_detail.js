// platforms/antigravity_enhance_detail.js — 增强插件叠层 GitHub 详情弹窗、图片代理兜底、灯箱与交互控制

const _activeEnhanceDetail = { appId: null, cardId: null };
const _enhanceImageProxyCache = new Map();
let _enhanceDetailEventsBound = false;

async function fetchEnhanceProxiedImage(url) {
  if (!url || typeof invoke !== 'function') return '';
  if (_enhanceImageProxyCache.has(url)) return _enhanceImageProxyCache.get(url);
  const promise = invoke('get_enhance_github_image', { url }).catch(() => '');
  _enhanceImageProxyCache.set(url, promise);
  const res = await promise;
  if (!res) _enhanceImageProxyCache.delete(url);
  return res || '';
}

function replaceBrokenDetailImage(img) {
  if (!img || !img.parentNode) return;
  const alt = (img.getAttribute('alt') || '').trim();
  const isBadge = img.classList.contains('enhance-md-badge');
  if (isBadge && alt) {
    const pill = document.createElement('span');
    pill.className = 'enhance-md-badge-fallback';
    pill.textContent = alt;
    img.replaceWith(pill);
    return;
  }
  const origSrc = img.getAttribute('data-orig-src') || img.getAttribute('src') || '';
  const fallback = document.createElement('a');
  fallback.className = 'enhance-md-img-fallback';
  fallback.setAttribute('href', '#');
  fallback.setAttribute('data-action', 'openAntigravityEnhanceRepo');
  fallback.setAttribute('data-arg', origSrc);
  fallback.textContent = alt || et('agEnhance.detailOpenExternal');
  img.replaceWith(fallback);
}

function hydrateEnhanceDetailMedia(container) {
  if (!container) return;
  const imgs = container.querySelectorAll('.enhance-md-body img');
  imgs.forEach((img) => {
    const origSrc = img.getAttribute('src') || '';
    const fallbackSrc = img.getAttribute('data-fallback-src') || '';
    img.setAttribute('data-orig-src', origSrc);
    let step = 0;

    const handleFailure = async () => {
      if (!img.isConnected) return;
      step += 1;
      if (step === 1 && fallbackSrc && img.getAttribute('src') !== fallbackSrc) {
        img.setAttribute('src', fallbackSrc);
        return;
      }
      if (step <= 2 && typeof invoke === 'function') {
        const candidates = [origSrc, fallbackSrc].filter((u) => /^https:\/\//i.test(u));
        for (const u of candidates) {
          const dataUri = await fetchEnhanceProxiedImage(u);
          if (!img.isConnected) return;
          if (dataUri) {
            img.setAttribute('src', dataUri);
            return;
          }
        }
      }
      replaceBrokenDetailImage(img);
    };

    img.addEventListener('error', () => { void handleFailure(); });
  });
}

function openAntigravityEnhanceLightbox(src, alt = '') {
  const box = document.getElementById(ENHANCE_LIGHTBOX_ID);
  if (!box || !src) return;
  box.innerHTML = `
    <div class="enhance-lightbox-frame">
      <button type="button" class="enhance-lightbox-close" data-action="closeAntigravityEnhanceLightbox" aria-label="${enhanceEscape(et('agEnhance.detailCloseBtn'))}">
        ${antigravityEnhanceIcon('close', 16)}
      </button>
      <img class="enhance-lightbox-img" src="${enhanceEscape(src)}" alt="${enhanceEscape(alt)}" referrerpolicy="no-referrer">
      ${alt ? `<div class="enhance-lightbox-caption">${enhanceEscape(alt)}</div>` : ''}
    </div>`;
  box.classList.add('active');
}

function closeAntigravityEnhanceLightbox() {
  const box = document.getElementById(ENHANCE_LIGHTBOX_ID);
  if (!box) return;
  box.classList.remove('active');
  box.innerHTML = '';
}

function scrollEnhanceDetailToAnchor(modalEl, rawSlug) {
  const slug = normalizeAnchorSlug(rawSlug);
  if (!slug || !modalEl) return;
  const scrollBox = modalEl.querySelector('.enhance-detail-scroll');
  if (!scrollBox) return;
  const headings = Array.from(scrollBox.querySelectorAll('[data-anchor-id]'));
  const target = headings.find((h) => h.getAttribute('data-anchor-id') === slug)
    || headings.find((h) => h.getAttribute('data-anchor-id')?.includes(slug));
  if (!target) return;
  const boxRect = scrollBox.getBoundingClientRect();
  const targetRect = target.getBoundingClientRect();
  const nextTop = Math.max(0, scrollBox.scrollTop + (targetRect.top - boxRect.top) - 16);
  if (typeof scrollBox.scrollTo === 'function') scrollBox.scrollTo({ top: nextTop, behavior: 'smooth' });
  else scrollBox.scrollTop = nextTop;
}

function ensureEnhanceDetailEvents() {
  if (_enhanceDetailEventsBound || typeof document === 'undefined') return;
  _enhanceDetailEventsBound = true;

  document.addEventListener('click', (e) => {
    const modal = document.getElementById(ENHANCE_DETAIL_MODAL_ID);
    if (!modal || !modal.classList.contains('active') || !modal.contains(e.target)) return;

    const anchor = e.target.closest?.('a[data-enhance-anchor]');
    if (anchor) {
      e.preventDefault();
      scrollEnhanceDetailToAnchor(modal, anchor.getAttribute('data-enhance-anchor'));
      return;
    }

    const zoomImg = e.target.closest?.('img[data-enhance-zoom]');
    if (zoomImg) {
      e.preventDefault();
      openAntigravityEnhanceLightbox(zoomImg.currentSrc || zoomImg.getAttribute('src') || '', zoomImg.getAttribute('alt') || '');
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const lightbox = document.getElementById(ENHANCE_LIGHTBOX_ID);
    if (lightbox?.classList.contains('active')) {
      e.preventDefault();
      e.stopImmediatePropagation();
      closeAntigravityEnhanceLightbox();
      return;
    }
    const detailModal = document.getElementById(ENHANCE_DETAIL_MODAL_ID);
    if (detailModal?.classList.contains('active')) {
      e.preventDefault();
      e.stopImmediatePropagation();
      closeAntigravityEnhanceDetail(_activeEnhanceDetail.appId);
    }
  }, true);
}

function formatDetailDate(iso) {
  if (!iso) return '';
  const m = String(iso).match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : String(iso).slice(0, 10);
}

function buildEnhanceDetailViewHtml(appId, ctx, etFn) {
  const { icon = 'extension', title, repo, badge, tone, versionText, introItems = [], conflictHtml = '', actionsHtml = '', loading, error, data } = ctx;
  const metaPills = [];
  if (versionText) metaPills.push(`<span class="enhance-detail-pill">${enhanceEscape(versionText)}</span>`);
  if (typeof data?.stars === 'number') {
    metaPills.push(`<span class="enhance-detail-pill">${antigravityEnhanceIcon('star', 12)}<span>${enhanceEscape(String(data.stars))}</span></span>`);
  }
  if (data?.license) metaPills.push(`<span class="enhance-detail-pill">${enhanceEscape(data.license)}</span>`);
  const updatedDate = formatDetailDate(data?.updatedAt);
  if (updatedDate) {
    metaPills.push(`<span class="enhance-detail-pill">${enhanceEscape(etFn('agEnhance.detailUpdatedPrefix'))}${enhanceEscape(updatedDate)}</span>`);
  }
  const renderSourcePill = data && !loading && !error
    ? `<span class="enhance-detail-pill is-source">${antigravityEnhanceIcon('globe', 12)}<span>${enhanceEscape(etFn(data.renderedOnline ? 'agEnhance.detailRenderedOnline' : 'agEnhance.detailRenderedMarkdown'))}</span></span>`
    : '';

  let readmeSection = '';
  if (loading) {
    const loadHtml = typeof loadingHtml === 'function'
      ? loadingHtml(enhanceEscape(etFn('agEnhance.detailLoadingHint')), 14)
      : enhanceEscape(etFn('agEnhance.detailLoadingHint'));
    readmeSection = `
      <div class="enhance-detail-loading-bar">${loadHtml}</div>
      <div class="enhance-detail-skeleton" aria-busy="true">
        <span class="health-skeleton-line w-45"></span>
        <span class="health-skeleton-line w-90"></span>
        <span class="health-skeleton-line w-75"></span>
        <span class="health-skeleton-line block"></span>
      </div>`;
  } else if (error) {
    readmeSection = `
      <div class="enhance-detail-error">
        <p>${enhanceEscape(error)}</p>
        <div class="enhance-detail-error-actions">
          <button type="button" class="btn-ghost secondary" data-action="refreshAntigravityEnhanceDetail" data-pass-this>${enhanceEscape(etFn('agEnhance.detailRetryBtn'))}</button>
          <button type="button" class="btn-ghost enhance-detail-open-external" data-action="openAntigravityEnhanceRepo" data-arg="${enhanceEscape(repo)}">${antigravityEnhanceIcon('external', 13)}<span>${enhanceEscape(etFn('agEnhance.detailOpenExternal'))}</span></button>
        </div>
      </div>`;
  } else if (data?.readmeHtml) {
    const rendered = sanitizeEnhanceGithubHtml(data.readmeHtml, data.repo || repo, data.defaultBranch || 'main');
    readmeSection = `<div class="enhance-md-body">${rendered}</div>`;
  } else if (data?.readmeMarkdown) {
    const rendered = renderEnhanceGithubMarkdown(data.readmeMarkdown, data.repo || repo, data.defaultBranch || 'main');
    readmeSection = `<div class="enhance-md-body">${rendered}</div>`;
  } else if (introItems.length) {
    readmeSection = `<div class="enhance-detail-fallback"><ul>${introItems.map((line) => `<li>${enhanceEscape(line)}</li>`).join('')}</ul></div>`;
  }

  const footNote = data
    ? `${data.readmeFilename || 'README.md'} · ${etFn(data.renderedOnline ? 'agEnhance.detailSourceOnline' : 'agEnhance.detailSourceFallback')}`
    : repo;

  return `
    <div class="enhance-detail-header">
      <div class="enhance-detail-header-main">
        <div class="enhance-card-icon tone-${enhanceEscape(tone)}">${antigravityEnhanceIcon(icon, 18)}</div>
        <div class="enhance-detail-header-copy">
          <div class="enhance-detail-title-group">
            <h3 class="enhance-detail-title" id="antigravityEnhanceDetailTitle">${enhanceEscape(title)}</h3>
            ${badge ? `<span class="enhance-badge ${tone === 'ok' ? 'ok' : tone === 'warn' ? 'warn' : tone === 'bad' ? 'bad' : ''}">${enhanceEscape(badge)}</span>` : ''}
          </div>
          <div class="enhance-detail-repo-row">
            <span class="enhance-detail-repo-slug">${antigravityEnhanceIcon('github', 12)}<span>${enhanceEscape(repo)}</span></span>
            ${metaPills.join('')}
          </div>
        </div>
      </div>
      <div class="enhance-detail-header-actions">
        <button type="button" class="enhance-detail-icon-btn" data-action="refreshAntigravityEnhanceDetail" data-pass-this title="${enhanceEscape(etFn('agEnhance.detailRefreshTitle'))}">
          ${antigravityEnhanceIcon('refresh', 14)}<span>${enhanceEscape(etFn('agEnhance.detailRefreshBtn'))}</span>
        </button>
        <button type="button" class="enhance-detail-icon-btn enhance-detail-open-external" data-action="openAntigravityEnhanceRepo" data-arg="${enhanceEscape(repo)}">
          ${antigravityEnhanceIcon('external', 14)}<span>${enhanceEscape(etFn('agEnhance.detailOpenExternal'))}</span>
        </button>
        <button type="button" class="enhance-detail-close" data-action="closeAntigravityEnhanceDetail" data-arg="${enhanceEscape(appId)}" aria-label="${enhanceEscape(etFn('agEnhance.detailCloseAria'))}">
          ${antigravityEnhanceIcon('close', 15)}
        </button>
      </div>
    </div>
    <div class="enhance-detail-scroll">
      ${data?.description || conflictHtml ? `
        <div class="enhance-detail-summary">
          ${data?.description ? `<p class="enhance-detail-gh-desc">${enhanceEscape(data.description)}</p>` : ''}
          ${conflictHtml}
        </div>` : ''}
      <div class="enhance-detail-readme-card">
        <div class="enhance-detail-readme-head">
          <span>${enhanceEscape(data?.readmeFilename || 'README.md')}</span>
          <span class="enhance-detail-readme-meta">
            ${renderSourcePill}
            ${data?.defaultBranch ? `<span class="enhance-detail-branch-tag">${enhanceEscape(data.defaultBranch)}</span>` : ''}
          </span>
        </div>
        ${readmeSection}
      </div>
    </div>
    <div class="enhance-detail-footer">
      <span class="enhance-detail-foot-note" title="${enhanceEscape(footNote)}">${enhanceEscape(footNote)}</span>
      <div class="enhance-detail-actions">
        ${actionsHtml}
        <button type="button" class="btn-ghost secondary enhance-detail-close" data-action="closeAntigravityEnhanceDetail" data-arg="${enhanceEscape(appId)}">${enhanceEscape(etFn('agEnhance.detailCloseBtn'))}</button>
      </div>
    </div>`;
}

function resolveEnhanceDetailContext(appId, cardId) {
  const id = normalizeEnhanceApp(appId);
  const state = appState(id);
  if (cardId === 'antigravity-localization') {
    const locStatus = state.locStatus;
    const localized = Boolean(locStatus?.localized);
    const installed = locStatus ? Boolean(locStatus.installed) : true;
    const ver = locStatus?.currentVersion ? `v${locStatus.currentVersion}` : et('agEnhance.builtinDict');
    return {
      id: cardId,
      icon: 'lang',
      title: et('agEnhance.locProjectName'),
      repo: LOC_UPSTREAM_REPO,
      tone: !installed ? 'bad' : localized ? 'ok' : 'muted',
      badge: !installed ? et('agEnhance.hostMissingBadge') : localized ? et('agEnhance.localized') : et('agEnhance.unlocalized'),
      versionText: ver,
      introItems: [et('agEnhance.locIntro1'), et('agEnhance.locIntro2'), et('agEnhance.locIntro3Ide')],
      conflictHtml: '',
      actionsHtml: buildLocalizationActionsHtml(installed, localized)
    };
  }
  const item = (state.items || []).find((x) => x.id === cardId);
  const catalog = ANTIGRAVITY_ENHANCE_CATALOG[cardId] || {};
  const repo = item?.repo || catalog.repo || '';
  if (!repo) return null;
  const installed = Boolean(item?.installed);
  const compatible = item ? item.compatible !== false : true;
  const hasUpdate = Boolean(item?.hasUpdate && item?.latestVersion);
  return {
    id: cardId,
    icon: catalog.icon || 'extension',
    title: item?.name || repo.split('/').pop() || cardId,
    repo,
    tone: !compatible ? 'bad' : hasUpdate ? 'warn' : installed ? 'ok' : 'muted',
    badge: !compatible ? et('agEnhance.hostMissingBadge') : hasUpdate ? et('agEnhance.hasUpdateBadge') : (installed ? et('agEnhance.installed') : et('agEnhance.notInstalled')),
    versionText: item?.version ? `v${item.version}` : '',
    introItems: (catalog.introKeys || []).map((k) => et(k)),
    conflictHtml: item ? buildEnhanceConflictCalloutsHtml(state.items, item, et, 'full') : '',
    actionsHtml: item ? buildItemActionsHtml(item) : ''
  };
}

function renderActiveEnhanceDetail(appId) {
  const id = normalizeEnhanceApp(appId);
  const state = appState(id);
  const modal = document.getElementById(ENHANCE_DETAIL_MODAL_ID);
  const dialog = document.getElementById(ENHANCE_DETAIL_DIALOG_ID);
  if (!modal || !dialog) return;

  if (!state.activeDetailId) {
    if (_activeEnhanceDetail.appId === id || !_activeEnhanceDetail.appId) {
      _activeEnhanceDetail.appId = null;
      _activeEnhanceDetail.cardId = null;
      modal.classList.remove('active');
      modal.removeAttribute('data-enhance-app');
      dialog.innerHTML = '';
      closeAntigravityEnhanceLightbox();
    }
    return;
  }

  const ctx = resolveEnhanceDetailContext(id, state.activeDetailId);
  if (!ctx) {
    state.activeDetailId = null;
    modal.classList.remove('active');
    dialog.innerHTML = '';
    return;
  }

  ensureEnhanceDetailEvents();
  const prevScroll = dialog.querySelector('.enhance-detail-scroll')?.scrollTop || 0;
  const sameCard = _activeEnhanceDetail.appId === id && _activeEnhanceDetail.cardId === state.activeDetailId;

  _activeEnhanceDetail.appId = id;
  _activeEnhanceDetail.cardId = state.activeDetailId;
  modal.setAttribute('data-enhance-app', id);
  modal.classList.add('active');

  dialog.innerHTML = buildEnhanceDetailViewHtml(id, {
    ...ctx,
    loading: state.detailLoading,
    error: state.detailError,
    data: state.detailCache.get(ctx.repo) || null
  }, et);

  const nextScroll = dialog.querySelector('.enhance-detail-scroll');
  if (nextScroll && sameCard && prevScroll > 0 && !state.detailLoading) {
    nextScroll.scrollTop = prevScroll;
  }
  hydrateEnhanceDetailMedia(dialog);
}

async function fetchEnhanceDetailData(appId, cardId, forceRefresh = false) {
  const id = normalizeEnhanceApp(appId);
  const state = appState(id);
  const ctx = resolveEnhanceDetailContext(id, cardId);
  if (!ctx) return;
  if (typeof invoke !== 'function') {
    renderActiveEnhanceDetail(id);
    return;
  }

  if (!forceRefresh && state.detailCache.has(ctx.repo)) {
    state.detailLoading = false;
    state.detailError = '';
    renderActiveEnhanceDetail(id);
    return;
  }

  const seq = ++state.detailSeq;
  state.detailLoading = true;
  state.detailError = '';
  renderActiveEnhanceDetail(id);

  try {
    const data = await invoke('get_enhance_github_detail', { repo: ctx.repo, forceRefresh: Boolean(forceRefresh) });
    if (seq !== state.detailSeq || state.activeDetailId !== cardId) return;
    if (data) state.detailCache.set(ctx.repo, data);
    state.detailLoading = false;
    state.detailError = '';
    renderActiveEnhanceDetail(id);
  } catch (err) {
    if (seq !== state.detailSeq || state.activeDetailId !== cardId) return;
    state.detailLoading = false;
    state.detailError = String(err?.message || err || et('agEnhance.detailLoadFailed'));
    renderActiveEnhanceDetail(id);
  }
}

function openAntigravityEnhanceDetail(triggerOrId, cardId = null) {
  const isLegacy = typeof triggerOrId === 'string';
  const targetCardId = isLegacy ? triggerOrId : cardId;
  const appId = resolveEnhanceApp(isLegacy ? null : triggerOrId);
  if (!targetCardId) return;
  const state = appState(appId);
  state.activeDetailId = targetCardId;
  void fetchEnhanceDetailData(appId, targetCardId, false);
}

function closeAntigravityEnhanceDetail(triggerOrApp = null, appArg = null) {
  const id = (triggerOrApp === 'antigravity' || triggerOrApp === 'antigravity-ide')
    ? triggerOrApp
    : (appArg === 'antigravity' || appArg === 'antigravity-ide')
      ? appArg
      : (_activeEnhanceDetail.appId || resolveEnhanceApp(triggerOrApp, appArg));
  const state = appState(id);
  state.activeDetailId = null;
  state.detailLoading = false;
  state.detailError = '';
  state.detailSeq += 1;
  renderActiveEnhanceDetail(id);
}

function refreshAntigravityEnhanceDetail(triggerEl = null) {
  const appId = _activeEnhanceDetail.appId || resolveEnhanceApp(triggerEl);
  const state = appState(appId);
  if (!state.activeDetailId) return;
  void fetchEnhanceDetailData(appId, state.activeDetailId, true);
}

Object.assign(globalThis, {
  buildEnhanceDetailViewHtml,
  renderActiveEnhanceDetail,
  openAntigravityEnhanceDetail,
  closeAntigravityEnhanceDetail,
  refreshAntigravityEnhanceDetail,
  openAntigravityEnhanceLightbox,
  closeAntigravityEnhanceLightbox
});
