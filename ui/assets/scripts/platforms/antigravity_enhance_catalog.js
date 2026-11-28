// platforms/antigravity_enhance_catalog.js — Antigravity 增强插件目录元数据、图标与分级冲突提醒纯逻辑

const LOC_UPSTREAM_REPO = 'liominsb/Antigravity-Chinese-Localization';

const ANTIGRAVITY_ENHANCE_CATALOG = {
  'antigravity-context-viewer': {
    icon: 'dashboard',
    mode: 'asar',
    repo: 'elviscjn-cjn/antigravity-context-viewer',
    tagKeys: ['agEnhance.tagTopbar', 'agEnhance.tagBuiltinHans', 'agEnhance.tagMultiAccount'],
    descKey: 'agEnhance.viewerDesc',
    introKeys: ['agEnhance.viewerIntro1', 'agEnhance.viewerIntroHans', 'agEnhance.viewerIntro2', 'agEnhance.viewerIntro3']
  },
  'antigravity-usage-monitor': {
    icon: 'gauge',
    mode: 'native-plugin',
    repo: 'yuhuan-dev/antigravity-usage-monitor',
    tagKeys: ['agEnhance.usageTagNative', 'agEnhance.usageTagSpeed', 'agEnhance.usageTagQuota'],
    descKey: 'agEnhance.usageDesc',
    introKeys: ['agEnhance.usageIntro1', 'agEnhance.usageIntro2', 'agEnhance.usageIntro3']
  },
  'antigravity-codex-theme': {
    icon: 'palette',
    mode: 'cdp-theme',
    repo: 'nkjDSLcvanv/antigravity-codex-theme',
    tagKeys: ['agEnhance.codexTagTheme', 'agEnhance.codexTagZeroPatch', 'agEnhance.codexTagTelemetry'],
    descKey: 'agEnhance.codexDesc',
    introKeys: ['agEnhance.codexIntro1', 'agEnhance.codexIntro2', 'agEnhance.codexIntro3']
  },
  'chuanban-antigravity-theme-patch': {
    icon: 'palette',
    mode: 'cdp-theme',
    repo: 'Anarcadia/chuanban-antigravity-theme-patch',
    tagKeys: ['agEnhance.chuanbanTagTheme', 'agEnhance.chuanbanTagZeroPatch', 'agEnhance.chuanbanTagAnalytics'],
    descKey: 'agEnhance.chuanbanDesc',
    introKeys: ['agEnhance.chuanbanIntro1', 'agEnhance.chuanbanIntro2', 'agEnhance.chuanbanIntro3']
  }
};

const ENHANCE_DETAIL_MODAL_ID = 'antigravityEnhanceDetailModal';
const ENHANCE_DETAIL_DIALOG_ID = 'antigravityEnhanceDetailDialog';
const ENHANCE_LIGHTBOX_ID = 'antigravityEnhanceImageLightbox';

const ENHANCE_APPS = {
  antigravity: {
    modalId: 'antigravityEnhanceModal',
    listViewId: 'antigravityEnhanceListView',
    listId: 'antigravityEnhanceList',
    logDrawerId: 'antigravityEnhanceLogDrawer',
    logPreviewId: 'antigravityEnhanceLogPreview',
    logId: 'antigravityEnhanceLog',
    refreshBtnId: 'antigravityEnhanceRefreshBtn'
  },
  'antigravity-ide': {
    modalId: 'antigravityIdeEnhanceModal',
    listViewId: 'antigravityIdeEnhanceListView',
    listId: 'antigravityIdeEnhanceList',
    logDrawerId: 'antigravityIdeEnhanceLogDrawer',
    logPreviewId: 'antigravityIdeEnhanceLogPreview',
    logId: 'antigravityIdeEnhanceLog',
    refreshBtnId: 'antigravityIdeEnhanceRefreshBtn'
  }
};

const ANTIGRAVITY_ENHANCE_ICONS = {
  extension: '<path d="M20.5 11H19V7c0-1.1-.9-2-2-2h-4V3.5C13 2.12 11.88 1 10.5 1S8 2.12 8 3.5V5H4c-1.1 0-1.99.9-1.99 2v3.8H3.5c1.49 0 2.7 1.21 2.7 2.7s-1.21 2.7-2.7 2.7H2V20c0 1.1.9 2 2 2h3.8v-1.5c0-1.49 1.21-2.7 2.7-2.7 1.49 0 2.7 1.21 2.7 2.7V22H17c1.1 0 2-.9 2-2v-4h1.5c1.38 0 2.5-1.12 2.5-2.5S21.88 11 20.5 11z"/>',
  lang: '<path d="m5 8 6 6"/><path d="m4 14 6-6 2-3"/><path d="M2 5h12"/><path d="M7 2h1"/><path d="m22 22-5-10-5 10"/><path d="M14 18h6"/>',
  dashboard: '<rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/>',
  gauge: '<path d="M12 14l4-4"/><path d="M3.34 19a10 10 0 1 1 17.32 0"/><circle cx="12" cy="14" r="1.5"/>',
  palette: '<circle cx="13.5" cy="6.5" r=".5" fill="currentColor"/><circle cx="17.5" cy="10.5" r=".5" fill="currentColor"/><circle cx="8.5" cy="7.5" r=".5" fill="currentColor"/><circle cx="6.5" cy="12.5" r=".5" fill="currentColor"/><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.668h1.996c3.051 0 5.555-2.503 5.555-5.554C21.965 6.012 17.461 2 12 2z"/>',
  github: '<path d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.53 1.032 1.53 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0 1 12 6.844a9.59 9.59 0 0 1 2.504.337c1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0 0 22 12.017C22 6.484 17.522 2 12 2z"/>',
  external: '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>',
  back: '<polyline points="15 18 9 12 15 6"/>',
  close: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
  refresh: '<polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>',
  star: '<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>',
  globe: '<circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>',
  info: '<circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>',
  warn: '<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>',
  chevron: '<polyline points="6 9 12 15 18 9"/>'
};

const ENHANCE_ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ENHANCE_LOG_META = {
  ok: ['agEnhance.logOk', 'var(--success)'],
  warn: ['agEnhance.logWarn', 'var(--accent-warm)'],
  err: ['agEnhance.logErr', 'var(--danger)'],
  info: ['agEnhance.logInfo', '']
};

const CONFLICT_REASON_I18N_KEYS = {
  cdp_theme_daemon: 'agEnhance.conflictReasonCdpThemeDaemon',
  topbar_i18n_account: 'agEnhance.conflictReasonTopbarI18nAccount',
  codex_skip_i18n_with_viewer: 'agEnhance.conflictReasonCodexSkipI18n',
  viewer_with_codex_i18n: 'agEnhance.conflictReasonViewerWithCodex',
  viewer_chuanban_i18n_stats: 'agEnhance.conflictReasonViewerChuanban',
  monitor_theme_coexist: 'agEnhance.conflictReasonMonitorThemeCoexist'
};

function enhanceEscape(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, (ch) => ENHANCE_ESC_MAP[ch]);
}

function antigravityEnhanceIcon(name, size = 20, filled = false) {
  const body = ANTIGRAVITY_ENHANCE_ICONS[name] || ANTIGRAVITY_ENHANCE_ICONS.extension;
  const useFill = filled || name === 'github' || name === 'extension';
  const attrs = useFill
    ? 'fill="currentColor"'
    : 'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"';
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" ${attrs} aria-hidden="true">${body}</svg>`;
}

function resolveEnhanceConflictReason(conflict, etFn) {
  const key = conflict?.reasonCode ? CONFLICT_REASON_I18N_KEYS[conflict.reasonCode] : '';
  if (key) {
    const localized = etFn(key);
    if (localized && localized !== key) return localized;
  }
  return conflict?.reason || '';
}

function collectActiveEnhanceConflicts(items, item) {
  const list = Array.isArray(items) ? items : [];
  const byId = new Map(list.map((entry) => [entry.id, entry]));
  const rawList = Array.isArray(item?.conflicts) && item.conflicts.length
    ? item.conflicts
    : (Array.isArray(item?.conflictsWith)
      ? item.conflictsWith.map((peerId) => ({
        peerId,
        level: 'exclusive',
        reasonCode: 'cdp_theme_daemon',
        reason: '',
        active: Boolean(byId.get(peerId)?.installed)
      }))
      : []);

  const exclusive = [];
  const overlap = [];
  for (const entry of rawList) {
    if (!entry?.peerId) continue;
    const peerItem = byId.get(entry.peerId);
    const isActive = peerItem ? Boolean(peerItem.installed) : Boolean(entry.active);
    if (!isActive) continue;
    if (entry.level === 'exclusive') exclusive.push(entry);
    else overlap.push(entry);
  }
  return { exclusive, overlap };
}

function buildEnhanceConflictCalloutsHtml(items, item, etFn, density = 'compact') {
  const { exclusive, overlap } = collectActiveEnhanceConflicts(items, item);
  if (!exclusive.length && !overlap.length) return '';

  const installed = Boolean(item?.installed);
  const blocks = [];

  for (const entry of exclusive) {
    const tag = etFn(installed ? 'agEnhance.conflictBadgeActiveExclusive' : 'agEnhance.conflictBadgeExclusive');
    const text = installed
      ? `${etFn('agEnhance.conflictInstalledExclusivePrefix')}${entry.peerId}${etFn('agEnhance.conflictInstalledExclusiveSuffix')}`
      : `${etFn('agEnhance.conflictNotePrefix')}${entry.peerId}${etFn('agEnhance.conflictNoteSuffix')}`;
    blocks.push(
      `<div class="enhance-conflict-item is-exclusive"><span class="enhance-conflict-pill">${enhanceEscape(tag)}</span><span class="enhance-conflict-copy">${enhanceEscape(text)}</span></div>`
    );
  }

  if (overlap.length) {
    if (density === 'compact') {
      if (!exclusive.length) {
        const peers = overlap.map((e) => e.peerId).join(' / ');
        const tag = etFn(installed ? 'agEnhance.conflictBadgeCoexist' : 'agEnhance.conflictBadgeOverlap');
        const tip = overlap.length === 1
          ? resolveEnhanceConflictReason(overlap[0], etFn)
          : etFn('agEnhance.conflictCompactMultiHint');
        const copy = `${etFn('agEnhance.conflictOverlapPrefix')}${peers}${etFn('agEnhance.conflictCompactOverlapSuffix')}`;
        blocks.push(
          `<div class="enhance-conflict-item ${installed ? 'is-coexist' : 'is-overlap'} is-compact" title="${enhanceEscape(tip)}"><span class="enhance-conflict-pill">${enhanceEscape(tag)}</span><span class="enhance-conflict-copy">${enhanceEscape(copy)}</span></div>`
        );
      }
    } else {
      for (const entry of overlap) {
        const reason = resolveEnhanceConflictReason(entry, etFn);
        const tag = etFn(installed ? 'agEnhance.conflictBadgeCoexist' : 'agEnhance.conflictBadgeOverlap');
        const prefix = etFn(installed ? 'agEnhance.conflictCoexistPrefix' : 'agEnhance.conflictOverlapPrefix');
        const copy = reason ? `${prefix}${entry.peerId}${etFn('agEnhance.conflictReasonSep')}${reason}` : `${prefix}${entry.peerId}`;
        blocks.push(
          `<div class="enhance-conflict-item ${installed ? 'is-coexist' : 'is-overlap'}"><span class="enhance-conflict-pill">${enhanceEscape(tag)}</span><span class="enhance-conflict-copy">${enhanceEscape(copy)}</span></div>`
        );
      }
    }
  }

  return `<div class="enhance-conflict-list">${blocks.join('')}</div>`;
}

function getBaseInstallConfirmKey(itemId) {
  const mode = ANTIGRAVITY_ENHANCE_CATALOG[itemId]?.mode;
  if (mode === 'cdp-theme') return 'agEnhance.cdpInstallConfirm';
  if (mode === 'native-plugin') return 'agEnhance.nativeInstallConfirm';
  return 'agEnhance.installConfirm';
}

function getBaseUninstallConfirmKey(itemId) {
  const mode = ANTIGRAVITY_ENHANCE_CATALOG[itemId]?.mode;
  if (mode === 'cdp-theme') return 'agEnhance.cdpUninstallConfirm';
  if (mode === 'native-plugin') return 'agEnhance.nativeUninstallConfirm';
  return 'agEnhance.uninstallConfirm';
}

function buildEnhanceInstallConfirmText(items, item, etFn) {
  const itemId = item?.id || '';
  const { exclusive, overlap } = collectActiveEnhanceConflicts(items, item);
  const installed = Boolean(item?.installed);

  if (!exclusive.length && (installed || !overlap.length)) {
    return etFn(getBaseInstallConfirmKey(itemId));
  }

  const sections = [];
  if (exclusive.length) {
    const peerNames = exclusive.map((e) => e.peerId).join(', ');
    sections.push(`${etFn('agEnhance.cdpConflictInstallPrefix')}${peerNames}${etFn('agEnhance.cdpConflictInstallSuffix')}`);
  }
  if (!installed && overlap.length) {
    const lines = overlap.map((entry) => {
      const reason = resolveEnhanceConflictReason(entry, etFn);
      return reason
        ? `- ${entry.peerId}${etFn('agEnhance.conflictReasonSep')}${reason}`
        : `- ${entry.peerId}`;
    });
    sections.push(`${etFn('agEnhance.overlapConfirmHeader')}\n${lines.join('\n')}`);
  }
  sections.push(etFn(exclusive.length ? 'agEnhance.confirmContinuePrompt' : 'agEnhance.overlapConfirmFooter'));
  return sections.join('\n\n');
}

Object.assign(globalThis, {
  LOC_UPSTREAM_REPO,
  ANTIGRAVITY_ENHANCE_CATALOG,
  ENHANCE_DETAIL_MODAL_ID,
  ENHANCE_DETAIL_DIALOG_ID,
  ENHANCE_LIGHTBOX_ID,
  ENHANCE_APPS,
  ANTIGRAVITY_ENHANCE_ICONS,
  ENHANCE_ESC_MAP,
  ENHANCE_LOG_META,
  CONFLICT_REASON_I18N_KEYS,
  enhanceEscape,
  antigravityEnhanceIcon,
  resolveEnhanceConflictReason,
  collectActiveEnhanceConflicts,
  buildEnhanceConflictCalloutsHtml,
  getBaseInstallConfirmKey,
  getBaseUninstallConfirmKey,
  buildEnhanceInstallConfirmText
});
