// extensions/actions-and-versions.js — 扩展动作分发、部署向导与 CPA 版本切换弹窗

function handleExtensionAction(action) {
  switch (action) {
    case 'install-cpa':
      deployCpaSuite();
      break;
    case 'import-existing':
      showExtensionBackendPending(
        '导入已有服务',
        '将扫描现有 CPA / CPAMP 目录，读取版本、端口和配置，并纳入 AnyBridge 管理。'
      );
      break;
    case 'refresh':
      refreshExtensionStatuses();
      break;
    case 'open-cpamp':
      openExtensionURL(CPAMP_MANAGEMENT_URL, 'CPA Manager Plus');
      break;
    case 'open-cpamp-plugins':
      openExtensionURL(CPAMP_PLUGINS_URL, 'CPA 插件管理');
      break;
    case 'check-cpa-update':
      checkCpaExtensionUpdates();
      break;
    case 'stop-cpa-suite':
      stopCpaSuite();
      break;
    case 'start-cpa-suite':
      startCpaSuite();
      break;
    case 'uninstall-cpa-suite':
      uninstallCpaSuite();
      break;
    case 'restart-cpa-suite':
      restartCpaSuite();
      break;
    case 'update-cpa-suite':
      updateCpaSuite();
      break;
    case 'switch-cpa-version':
      openCpaVersionSwitchModal();
      break;
    case 'set-cpa-install-dir':
      setCpaInstallDir();
      break;
    case 'install-sub2api':
      showExtensionBackendPending(
        'sub2api 安装',
        '将按扩展清单下载并托管 sub2api，安装后可生成 AnyBridge 供应商配置。'
      );
      break;
    case 'install-grok2api':
      // grok2api 已迁移为运行时插件，安装入口在「运行时插件」区（66-plugins.js）
      if (typeof openPluginDeployDialog === 'function') openPluginDeployDialog('grok2api');
      break;
    case 'install-jimeng':
      // jimeng2api 已迁移为运行时插件，安装入口统一走插件部署弹窗
      if (typeof openPluginDeployDialog === 'function') openPluginDeployDialog('jimeng2api');
      break;
    case 'open-jimeng-homepage':
      if (typeof openPluginLink === 'function') {
        openPluginLink('https://github.com/zhizinan1997/jimeng-free-api-all');
      }
      break;
    case 'view-adapter-plan':
      extensionNotify('适配计划已写入 spec/35-扩展中心与一键部署规划.md。', 'info');
      extensionLog('info', '查看适配计划: spec/35-扩展中心与一键部署规划.md。');
      break;
    default:
      extensionNotify('扩展操作待接入。', 'info');
      extensionLog('warn', `未知扩展操作: ${action || '(empty)'}`);
  }
}

function bindDeployProgressListener() {
  if (!window.__deployProgressBound && typeof tauriEvent !== 'undefined' && tauriEvent?.listen) {
    window.__deployProgressBound = true;
    tauriEvent.listen('deploy-progress', (e) => {
      const p = e.payload || {};
      const level = p.isError ? 'err' : 'info';
      const percent = Number(p.percent);
      const message = p.message || '';
      if (Number.isFinite(percent)) {
        extensionDeployInProgress = true;
        setCpaProgress(percent, message, true);
      }
      if (p.step === 'download') {
        extensionLog(level, `${message} (${Number.isFinite(percent) ? `${percent}%` : '…'})`);
      } else if (message) {
        extensionLog(level, message);
      }
      if (p.step === 'done' || percent >= 100) {
        setCpaProgress(100, message || '完成', true);
      }
    });
  }
}

globalThis.CPA_DEPLOY_STEP_MAP = {
  check: 'check', fetch: 'fetch',
  download_cpa: 'download', download_cpamp: 'download', download: 'download',
  extract_cpa: 'extract', extract_cpamp: 'extract',
  config: 'config',
  start_cpa: 'start', start_cpamp: 'start',
  health_cpa: 'health', health_cpamp: 'health',
  done: 'done',
};
globalThis.CPA_DEPLOY_STEP_ORDER = ['check', 'fetch', 'download', 'extract', 'config', 'start', 'health'];

async function deployCpaSuite() {
  if (!ensureExtensionBridge()) {
    extensionLog('err', '桌面通信通道未就绪，无法执行部署。');
    return;
  }
  await showCpaDeployModal();
}

function showCpaDeployModal() {
  return new Promise(async (resolve) => {
    const modal = document.getElementById('cpa-deploy-modal');
    if (!modal) { resolve(null); return; }

    const confirmView = document.getElementById('cpa-deploy-confirm-view');
    const progressView = document.getElementById('cpa-deploy-progress-view');
    const resultView = document.getElementById('cpa-deploy-result-view');
    const titleEl = document.getElementById('cpa-deploy-modal-title');
    const iconEl = document.getElementById('cpa-deploy-modal-icon');
    const footer = document.getElementById('cpa-deploy-footer');
    const okBtn = document.getElementById('cpa-deploy-confirm-btn');
    const cancelBtn = document.getElementById('cpa-deploy-cancel-btn');
    const inputEl = document.getElementById('cpa-deploy-dir-input');
    const hintEl = document.getElementById('cpa-deploy-dir-hint');

    let defaultDir = cpaInstallDir || '';
    try {
      defaultDir = cpaInstallDir || (await invoke('extension_cpa_default_install_dir'));
    } catch (_) {}
    if (inputEl) {
      inputEl.value = cpaInstallDir || '';
      inputEl.placeholder = defaultDir ? `默认：${defaultDir}` : '留空使用默认目录';
    }
    if (hintEl) hintEl.textContent = defaultDir ? `默认目录：${defaultDir}` : '';

    const browseBtn = document.getElementById('cpa-deploy-dir-browse');
    if (browseBtn) {
      browseBtn.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        browseCpaDeployDir();
      };
    }

    function switchView(view) {
      confirmView.style.display = view === 'confirm' ? '' : 'none';
      progressView.style.display = view === 'progress' ? '' : 'none';
      resultView.style.display = view === 'result' ? '' : 'none';
    }

    function setFooter(cancelText, confirmText, confirmVisible, confirmHandler) {
      cancelBtn.textContent = cancelText || '取消';
      okBtn.textContent = confirmText || '确定';
      okBtn.style.display = confirmVisible === false ? 'none' : '';
      okBtn.onclick = confirmHandler || null;
      cancelBtn.onclick = null;
    }

    function resetSteps() {
      document.querySelectorAll('.cpa-deploy-step').forEach(s => {
        s.classList.remove('active', 'done', 'error');
      });
      const fill = document.getElementById('cpa-deploy-progress-fill');
      const pct = document.getElementById('cpa-deploy-progress-percent');
      const msg = document.getElementById('cpa-deploy-progress-message');
      const logBox = document.getElementById('cpa-deploy-log-box');
      if (fill) fill.style.width = '0%';
      if (pct) pct.textContent = '0%';
      if (msg) {
        if (typeof loadingHtml === 'function') msg.innerHTML = loadingHtml('准备中…');
        else msg.textContent = '准备中…';
      }
      if (logBox) logBox.innerHTML = '';
    }

    function updateStep(stepKey, state) {
      const mapped = CPA_DEPLOY_STEP_MAP[stepKey];
      if (!mapped || mapped === 'done') return;
      const el = document.querySelector(`.cpa-deploy-step[data-step="${mapped}"]`);
      if (!el) return;
      el.classList.remove('active', 'done', 'error');
      el.classList.add(state);
    }

    function markPriorDone(stepKey) {
      const mapped = CPA_DEPLOY_STEP_MAP[stepKey];
      if (!mapped) return;
      const idx = CPA_DEPLOY_STEP_ORDER.indexOf(mapped);
      if (idx < 0) return;
      for (let i = 0; i < idx; i++) {
        const prevEl = document.querySelector(`.cpa-deploy-step[data-step="${CPA_DEPLOY_STEP_ORDER[i]}"]`);
        if (prevEl && !prevEl.classList.contains('error')) {
          prevEl.classList.remove('active');
          prevEl.classList.add('done');
        }
      }
    }

    function appendDeployLog(message, level) {
      const logBox = document.getElementById('cpa-deploy-log-box');
      if (!logBox) return;
      const now = new Date();
      const ts = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}:${String(now.getSeconds()).padStart(2,'0')}`;
      const line = document.createElement('div');
      line.className = 'cpa-deploy-log-line';
      line.innerHTML = `<span class="cpa-deploy-log-ts">${ts}</span><span class="cpa-deploy-log-msg ${level || ''}">${message}</span>`;
      logBox.appendChild(line);
      logBox.scrollTop = logBox.scrollHeight;
    }

    function updateProgress(percent, message) {
      const fill = document.getElementById('cpa-deploy-progress-fill');
      const pct = document.getElementById('cpa-deploy-progress-percent');
      const msg = document.getElementById('cpa-deploy-progress-message');
      if (fill) fill.style.width = `${percent}%`;
      if (pct) pct.textContent = `${Math.round(percent)}%`;
      if (msg && message) msg.textContent = message;
    }

    function showResult(success, title, desc, errorDetail) {
      switchView('result');
      if (titleEl) titleEl.textContent = success ? '部署完成' : '部署失败';
      if (iconEl) iconEl.style.color = success ? 'var(--success)' : 'var(--danger)';

      const content = document.getElementById('cpa-deploy-result-content');
      if (content) {
        const checkSvg = '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>';
        const xSvg = '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>';
        content.innerHTML = `
          <div class="cpa-deploy-result-icon ${success ? 'success' : 'error'}">${success ? checkSvg : xSvg}</div>
          <div class="cpa-deploy-result-title">${title}</div>
          <div class="cpa-deploy-result-desc">${desc}</div>
          ${errorDetail ? `<div class="cpa-deploy-result-error-box">${errorDetail}</div>` : ''}
        `;
      }

      setFooter('关闭', '', false);
      cancelBtn.onclick = (e) => { e.preventDefault(); e.stopPropagation(); cleanup(); resolve(); };
    }

    let progressUnlisten = null;

    function cleanup() {
      modal.classList.remove('active');
      if (progressUnlisten) { progressUnlisten(); progressUnlisten = null; }
      document.removeEventListener('keydown', onEsc);
    }

    const onEsc = (e) => {
      if (e.key === 'Escape' && modal.classList.contains('active')) {
        if (progressView.style.display !== 'none') return;
        cleanup(); resolve();
      }
    };

    switchView('confirm');
    setFooter('取消', '开始部署', true, null);
    modal.classList.add('active');
    setTimeout(() => { if (inputEl) inputEl.focus(); }, 50);

    cancelBtn.onclick = (e) => { e.preventDefault(); e.stopPropagation(); cleanup(); resolve(); };
    modal.addEventListener('click', (e) => { if (e.target === modal && progressView.style.display === 'none') { cleanup(); resolve(); } });
    document.addEventListener('keydown', onEsc);

    okBtn.onclick = async (e) => {
      e.preventDefault(); e.stopPropagation();

      const dir = (inputEl?.value || '').trim();
      const finalDir = dir || defaultDir || '';
      if (dir && dir !== defaultDir) {
        cpaInstallDir = finalDir;
        renderCpaInstallDir();
        invoke('extension_set_cpa_install_dir', { dir }).catch(err => {
          extensionLog('warn', `保存安装目录失败: ${err?.message || err}`);
        });
      } else if (!dir) {
        cpaInstallDir = finalDir;
        renderCpaInstallDir();
      }

      switchView('progress');
      if (titleEl) titleEl.textContent = '正在部署...';
      if (iconEl) iconEl.style.color = 'var(--accent)';
      setFooter('后台运行', '', false);
      cancelBtn.onclick = (e) => { e.preventDefault(); e.stopPropagation(); cleanup(); resolve(); };
      resetSteps();
      appendDeployLog('开始部署 CPA 套件...', 'ok');

      setCpaSuiteTransientStatus('installing');
      setCpaProgress(1, '开始部署 CPA 套件...', true);

      if (typeof tauriEvent !== 'undefined' && tauriEvent?.listen) {
        tauriEvent.listen('deploy-progress', (ev) => {
          const p = ev.payload || {};
          const percent = Number(p.percent);
          const message = p.message || '';
          const step = p.step || '';

          if (Number.isFinite(percent)) {
            updateProgress(percent, message);
            setCpaProgress(percent, message, true);
          }

          if (step && step !== 'done') {
            markPriorDone(step);
            updateStep(step, 'active');
          }

          if (step === 'done' || percent >= 100) {
            CPA_DEPLOY_STEP_ORDER.forEach(s => {
              const el = document.querySelector(`.cpa-deploy-step[data-step="${s}"]`);
              if (el && !el.classList.contains('error')) {
                el.classList.remove('active');
                el.classList.add('done');
              }
            });
          }

          const level = p.isError ? 'err' : (step && step.startsWith('download') ? '' : '');
          appendDeployLog(message, level);
        }).then(unlisten => { progressUnlisten = unlisten; });
      }

      try {
        const result = await invoke('extension_deploy_cpa_suite', { installDir: finalDir });
        setCpaProgress(100, '部署完成', true);
        extensionServicesById.set(result.id, result);
        updateExtensionsMetric([result]);
        updateCpaSuiteCard(result);
        extensionLog('ok', `部署完成：CPA 套件 ${extensionStatusLabel(result.status)}`);
        extensionNotify('CPA 套件部署完成！', 'success');
        appendDeployLog('部署完成！', 'ok');
        // 刷新供应商列表，展示内置 CPA 本地供应商
        try {
          if (typeof loadProviders === 'function') await loadProviders();
          if (typeof renderProviders === 'function') renderProviders();
          if (typeof renderEvalProviderOptions === 'function') renderEvalProviderOptions();
        } catch (e) {
          extensionLog('warn', `刷新供应商列表失败: ${e?.message || e}`);
        }

        showResult(true, '部署完成', [
          'CPA 套件已成功部署并启动运行。',
          '<strong>CLIProxyAPI</strong>：端口 8317',
          '<strong>CPA Manager Plus</strong>：端口 18317',
          '已在供应商页添加内置「CPA」本地供应商（排在 AnyBridge 后）。',
          '点击卡片上的「打开面板」即可进入管理界面。'
        ].join('<br>'));
      } catch (err) {
        const msg = String(err?.message || err);
        setExtensionStatusBadge(document.getElementById('extension-cpa-status'), 'error', '部署失败');
        extensionLog('err', `部署失败: ${msg}`);
        extensionNotify(`部署失败: ${msg}`, 'error');
        renderCpaAlert({ status: 'error', notes: [msg] });
        appendDeployLog(`部署失败: ${msg}`, 'err');

        document.querySelectorAll('.cpa-deploy-step.active').forEach(s => {
          s.classList.remove('active');
          s.classList.add('error');
        });

        showResult(false, '部署失败', '部署过程中出现错误，请查看下方错误详情。', msg);
        await refreshExtensionStatuses({ silent: true });
      } finally {
        setTimeout(() => hideCpaProgress(), 800);
      }
    };
  });
}

// âââââââ CPA çæ¬åæ¢ âââââââ

globalThis.cpaVersionCatalog = null;
globalThis.cpaVersionSelected = { cli: null, cpamp: null };
globalThis.cpaVersionBusy = false;

function findCpaComponentVersions(catalog, id) {
  return ((catalog && catalog.components) || []).find(function (c) { return c.id === id; }) || null;
}

function formatCpaVersionDate(iso) {
  if (!iso) return '';
  try {
    var d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  } catch (_) {
    return '';
  }
}

function renderCpaVersionList(host, component, selectedVersion, onSelect) {
  if (!host) return;
  host.innerHTML = '';
  var versions = Array.isArray(component && component.versions) ? component.versions : [];
  if (!versions.length) {
    var empty = document.createElement('div');
    empty.className = 'cpa-version-empty';
    empty.textContent = '暂无可用版本（请检查网络或稍后重试）';
    host.appendChild(empty);
    return;
  }
  versions.forEach(function (entry) {
    var row = document.createElement('button');
    row.type = 'button';
    row.className = 'cpa-version-row';
    if (entry.version === selectedVersion) row.classList.add('is-selected');
    if (entry.active) row.classList.add('is-active');
    if (!entry.installed) row.classList.add('is-remote');
    var main = document.createElement('div');
    main.className = 'cpa-version-row-main';
    var ver = document.createElement('strong');
    ver.textContent = entry.version;
    main.appendChild(ver);
    var badges = document.createElement('div');
    badges.className = 'cpa-version-badges';
    if (entry.active) {
      var b1 = document.createElement('span');
      b1.className = 'cpa-version-badge cpa-version-badge-active';
      b1.textContent = '当前';
      badges.appendChild(b1);
    }
    if (entry.installed) {
      var b2 = document.createElement('span');
      b2.className = 'cpa-version-badge cpa-version-badge-installed';
      b2.textContent = '已安装';
      badges.appendChild(b2);
    } else {
      var b3 = document.createElement('span');
      b3.className = 'cpa-version-badge cpa-version-badge-remote';
      b3.textContent = '需下载';
      badges.appendChild(b3);
    }
    if (entry.prerelease) {
      var b4 = document.createElement('span');
      b4.className = 'cpa-version-badge cpa-version-badge-pre';
      b4.textContent = '预发布';
      badges.appendChild(b4);
    }
    main.appendChild(badges);
    var meta = document.createElement('div');
    meta.className = 'cpa-version-row-meta';
    var date = formatCpaVersionDate(entry.publishedAt);
    meta.textContent = date || (entry.installed ? '本地缓存' : 'GitHub');
    row.append(main, meta);
    row.onclick = function () { onSelect(entry.version); };
    host.appendChild(row);
  });
}

function updateCpaVersionConfirmLabel() {
  var btn = document.getElementById('cpa-version-confirm-btn');
  if (!btn || !cpaVersionCatalog) return;
  var cli = findCpaComponentVersions(cpaVersionCatalog, 'cli-proxy-api');
  var cpamp = findCpaComponentVersions(cpaVersionCatalog, 'cpa-manager-plus');
  var cliEntry = ((cli && cli.versions) || []).find(function (v) { return v.version === cpaVersionSelected.cli; });
  var cpampEntry = ((cpamp && cpamp.versions) || []).find(function (v) { return v.version === cpaVersionSelected.cpamp; });
  var needDownload = (cliEntry && !cliEntry.installed) || (cpampEntry && !cpampEntry.installed);
  var same = cliEntry && cliEntry.active && cpampEntry && cpampEntry.active;
  btn.disabled = Boolean(cpaVersionBusy) || !cpaVersionSelected.cli || !cpaVersionSelected.cpamp || same;
  if (same) btn.textContent = '已是当前版本';
  else if (needDownload) btn.textContent = '下载并切换';
  else btn.textContent = '切换到已选版本';
}

function refreshCpaVersionLists() {
  var cli = findCpaComponentVersions(cpaVersionCatalog, 'cli-proxy-api');
  var cpamp = findCpaComponentVersions(cpaVersionCatalog, 'cpa-manager-plus');
  renderCpaVersionList(document.getElementById('cpa-version-cli-list'), cli, cpaVersionSelected.cli, function (ver) {
    cpaVersionSelected.cli = ver;
    refreshCpaVersionLists();
  });
  renderCpaVersionList(document.getElementById('cpa-version-cpamp-list'), cpamp, cpaVersionSelected.cpamp, function (ver) {
    cpaVersionSelected.cpamp = ver;
    refreshCpaVersionLists();
  });
  var cliCur = document.getElementById('cpa-version-cli-current');
  var cpampCur = document.getElementById('cpa-version-cpamp-current');
  if (cliCur) cliCur.textContent = (cli && cli.currentVersion) || '未知';
  if (cpampCur) cpampCur.textContent = (cpamp && cpamp.currentVersion) || '未知';
  updateCpaVersionConfirmLabel();
}

function setCpaVersionProgress(visible, percent, message) {
  var wrap = document.getElementById('cpa-version-progress');
  var fill = document.getElementById('cpa-version-progress-fill');
  var pct = document.getElementById('cpa-version-progress-percent');
  var msg = document.getElementById('cpa-version-progress-message');
  if (wrap) wrap.hidden = !visible;
  if (fill && Number.isFinite(percent)) fill.style.width = Math.max(0, Math.min(100, percent)) + '%';
  if (pct && Number.isFinite(percent)) pct.textContent = Math.round(percent) + '%';
  if (msg && message) msg.textContent = message;
}

async function openCpaVersionSwitchModal() {
  if (!ensureExtensionBridge()) {
    extensionLog('err', '桌面通信通道未就绪，无法切换版本。');
    extensionNotify('桌面通信通道未就绪', 'error');
    return;
  }
  var modal = document.getElementById('cpa-version-modal');
  if (!modal) {
    extensionNotify('版本切换界面未就绪', 'error');
    return;
  }
  var confirmBtn = document.getElementById('cpa-version-confirm-btn');
  var cancelBtn = document.getElementById('cpa-version-cancel-btn');
  var loadingEl = document.getElementById('cpa-version-loading');
  var bodyEl = document.getElementById('cpa-version-body');
  cpaVersionBusy = false;
  setCpaVersionProgress(false, 0, '');
  if (loadingEl) { loadingEl.hidden = false; loadingEl.textContent = '正在加载本地与 GitHub 版本列表...'; }
  if (bodyEl) bodyEl.hidden = true;
  if (confirmBtn) { confirmBtn.disabled = true; confirmBtn.innerHTML = loadingHtml('加载中…'); }
  modal.classList.add('active');
  var onEsc = function (e) { if (e.key === 'Escape' && !cpaVersionBusy) closeCpaVersionSwitchModal(); };
  document.addEventListener('keydown', onEsc);
  modal._cpaVersionEsc = onEsc;
  if (cancelBtn) {
    cancelBtn.onclick = function (e) { e.preventDefault(); if (cpaVersionBusy) return; closeCpaVersionSwitchModal(); };
  }
  if (modal.dataset.overlayBound !== '1') {
    modal.dataset.overlayBound = '1';
    modal.addEventListener('click', function (e) { if (e.target === modal && !cpaVersionBusy) closeCpaVersionSwitchModal(); });
  }
  try {
    extensionLog('info', '正在加载 CPA 本地与远程版本列表...');
    var catalog = await invoke('extension_list_cpa_versions');
    cpaVersionCatalog = catalog || null;
    var cli = findCpaComponentVersions(cpaVersionCatalog, 'cli-proxy-api');
    var cpamp = findCpaComponentVersions(cpaVersionCatalog, 'cpa-manager-plus');
    cpaVersionSelected = {
      cli: (cli && cli.currentVersion) || (cli && cli.versions && cli.versions[0] && cli.versions[0].version) || null,
      cpamp: (cpamp && cpamp.currentVersion) || (cpamp && cpamp.versions && cpamp.versions[0] && cpamp.versions[0].version) || null
    };
    if (loadingEl) loadingEl.hidden = true;
    if (bodyEl) bodyEl.hidden = false;
    refreshCpaVersionLists();
    extensionLog('ok', '版本列表已加载：CPA ' + ((cli && cli.versions && cli.versions.length) || 0) + ' 个 / CPAMP ' + ((cpamp && cpamp.versions && cpamp.versions.length) || 0) + ' 个');
  } catch (e) {
    var message = String((e && e.message) || e);
    extensionLog('err', '加载版本列表失败: ' + message);
    if (loadingEl) { loadingEl.hidden = false; loadingEl.textContent = '加载失败：' + message; }
    if (confirmBtn) { confirmBtn.disabled = true; confirmBtn.textContent = '加载失败'; }
    return;
  }
  if (confirmBtn) {
    confirmBtn.onclick = async function (e) {
      e.preventDefault();
      if (cpaVersionBusy) return;
      await applyCpaVersionSelection();
    };
  }
}

function closeCpaVersionSwitchModal() {
  var modal = document.getElementById('cpa-version-modal');
  if (modal) modal.classList.remove('active');
  if (modal && modal._cpaVersionEsc) {
    document.removeEventListener('keydown', modal._cpaVersionEsc);
    modal._cpaVersionEsc = null;
  }
  setCpaVersionProgress(false, 0, '');
  cpaVersionBusy = false;
}

async function applyCpaVersionSelection() {
  if (!cpaVersionCatalog || !cpaVersionSelected.cli || !cpaVersionSelected.cpamp) return;
  var cli = findCpaComponentVersions(cpaVersionCatalog, 'cli-proxy-api');
  var cpamp = findCpaComponentVersions(cpaVersionCatalog, 'cpa-manager-plus');
  var cliEntry = ((cli && cli.versions) || []).find(function (v) { return v.version === cpaVersionSelected.cli; });
  var cpampEntry = ((cpamp && cpamp.versions) || []).find(function (v) { return v.version === cpaVersionSelected.cpamp; });
  if (!cliEntry || !cpampEntry) { extensionNotify('请选择有效的 CPA / CPAMP 版本', 'warn'); return; }
  if (cliEntry.active && cpampEntry.active) { extensionNotify('已是当前版本，无需切换', 'info'); return; }
  var needDownload = !cliEntry.installed || !cpampEntry.installed;
  var suite = extensionServicesById.get('cpa-suite');
  var isRunning = suite && (suite.status === 'running' || suite.status === 'degraded');
  var lines = [
    'CLIProxyAPI：' + ((cli && cli.currentVersion) || '未知') + ' → ' + cliEntry.version + (cliEntry.installed ? '' : '（需下载）'),
    'CPA Manager Plus：' + ((cpamp && cpamp.currentVersion) || '未知') + ' → ' + cpampEntry.version + (cpampEntry.installed ? '' : '（需下载）'),
    isRunning ? '切换时会短暂停止并重启服务。' : '切换后将按需启动服务。',
    needDownload ? '未安装的版本会从 GitHub 下载（可能需要几分钟）。' : '两个版本均已在本地，将直接切换。'
  ];
  var confirmed = typeof showCustomConfirm === 'function'
    ? await showCustomConfirm(lines.join('\n'), needDownload ? '下载并切换版本' : '确认切换版本', 'warn')
    : true;
  if (!confirmed) return;
  cpaVersionBusy = true;
  updateCpaVersionConfirmLabel();
  var confirmBtn = document.getElementById('cpa-version-confirm-btn');
  var cancelBtn = document.getElementById('cpa-version-cancel-btn');
  if (confirmBtn) {
    if (typeof setLoading === 'function') setLoading(confirmBtn, needDownload ? '下载中…' : '切换中…');
    else confirmBtn.disabled = true;
  }
  if (cancelBtn) cancelBtn.disabled = true;
  setCpaSuiteTransientStatus('updating');
  setCpaVersionProgress(true, 2, needDownload ? '准备下载指定版本...' : '正在切换版本...');
  extensionLog('warn', '开始' + (needDownload ? '下载并' : '') + '切换版本：CPA ' + cliEntry.version + ' / CPAMP ' + cpampEntry.version);
  var progressUnlisten = null;
  try {
    if (needDownload && typeof tauriEvent !== 'undefined' && tauriEvent && tauriEvent.listen) {
      progressUnlisten = await tauriEvent.listen('deploy-progress', function (ev) {
        var p = ev.payload || {};
        var percent = Number(p.percent);
        var msg = p.message || '';
        if (Number.isFinite(percent)) { setCpaVersionProgress(true, percent, msg); setCpaProgress(percent, msg, true); }
        else if (msg) { setCpaVersionProgress(true, undefined, msg); }
        if (msg) extensionLog(p.isError ? 'err' : 'info', msg);
      });
    }
    if (needDownload) {
      await invoke('extension_install_cpa_version', { cliVersion: cliEntry.version, cpampVersion: cpampEntry.version, restart: true });
    } else {
      await invoke('extension_switch_cpa_version', { cliVersion: cliEntry.version, cpampVersion: cpampEntry.version, restart: true });
    }
    setCpaVersionProgress(true, 100, '完成');
    extensionNotify('已切换到 CPA ' + cliEntry.version + ' / CPAMP ' + cpampEntry.version, 'success');
    extensionLog('ok', '版本切换完成：CPA ' + cliEntry.version + ' / CPAMP ' + cpampEntry.version);
    cpaUpdateReport = null;
    await refreshExtensionStatuses({ silent: true });
    closeCpaVersionSwitchModal();
  } catch (e) {
    var errMsg = String((e && e.message) || e);
    extensionLog('err', '版本切换失败: ' + errMsg);
    extensionNotify('版本切换失败: ' + errMsg, 'error');
    setCpaVersionProgress(true, undefined, '失败：' + errMsg);
    await refreshExtensionStatuses({ silent: true });
  } finally {
    if (typeof progressUnlisten === 'function') progressUnlisten();
    cpaVersionBusy = false;
    if (typeof clearLoading === 'function' && confirmBtn) clearLoading(confirmBtn);
    if (cancelBtn) cancelBtn.disabled = false;
    updateCpaVersionConfirmLabel();
    setTimeout(function () { hideCpaProgress(); }, 800);
  }
}

// ---- P3 globalThis mirror ----
(function mirrorFns(g) {
  g.handleExtensionAction = handleExtensionAction;
  g.bindDeployProgressListener = bindDeployProgressListener;
  g.deployCpaSuite = deployCpaSuite;
  g.showCpaDeployModal = showCpaDeployModal;
  g.findCpaComponentVersions = findCpaComponentVersions;
  g.formatCpaVersionDate = formatCpaVersionDate;
  g.renderCpaVersionList = renderCpaVersionList;
  g.updateCpaVersionConfirmLabel = updateCpaVersionConfirmLabel;
  g.refreshCpaVersionLists = refreshCpaVersionLists;
  g.setCpaVersionProgress = setCpaVersionProgress;
  g.openCpaVersionSwitchModal = openCpaVersionSwitchModal;
  g.closeCpaVersionSwitchModal = closeCpaVersionSwitchModal;
  g.applyCpaVersionSelection = applyCpaVersionSelection;
})(globalThis);
