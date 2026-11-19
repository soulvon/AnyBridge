// extensions/cpa-proxy-modal.js — CPA 自启动、代理模式切换与详情弹窗视图

async function loadCpaAutoStart() {
  if (!ensureExtensionBridge()) return true;
  try {
    const enabled = await invoke('extension_cpa_auto_start');
    cpaAutoStart = enabled !== false;
  } catch (e) {
    extensionLog('warn', `读取 CPA 跟随启动设置失败: ${e?.message || e}`);
    cpaAutoStart = true;
  }
  return cpaAutoStart;
}

async function setCpaAutoStart(enabled) {
  if (!ensureExtensionBridge()) {
    throw new Error('桌面通信通道未就绪');
  }
  const next = await invoke('extension_set_cpa_auto_start', { enabled: Boolean(enabled) });
  cpaAutoStart = next !== false;
  extensionLog('info', `CPA 跟随软件启动: ${cpaAutoStart ? '已开启' : '已关闭'}`);
  extensionNotify(cpaAutoStart ? '已开启跟随软件启动' : '已关闭跟随软件启动', 'info');
  return cpaAutoStart;
}

function normalizeCpaProxyView(view) {
  return {
    mode: String(view?.mode || 'system').toLowerCase(),
    customUrl: String(view?.customUrl || ''),
    systemUrl: view?.systemUrl || null,
    effectiveUrl: String(view?.effectiveUrl || ''),
    appliedUrl: view?.appliedUrl ?? null,
    needsRestart: Boolean(view?.needsRestart),
    suiteRunning: Boolean(view?.suiteRunning)
  };
}

function cpaProxyModeLabel(mode) {
  switch (String(mode || '').toLowerCase()) {
    case 'custom':
      return '自定义代理';
    case 'off':
      return '直连（不走代理）';
    default:
      return '跟随系统代理';
  }
}

function cpaProxyEffectiveText(view) {
  const mode = view?.mode || 'system';
  if (mode === 'off') return '直连（空 proxy-url）';
  const url = String(view?.effectiveUrl || '').trim();
  if (url) return url;
  if (mode === 'system') return '系统代理未启用 / 未检测到';
  return '未配置';
}

async function loadCpaProxySettings() {
  if (!ensureExtensionBridge()) return cpaProxySettings;
  try {
    const view = await invoke('extension_cpa_proxy_settings');
    cpaProxySettings = normalizeCpaProxyView(view);
  } catch (e) {
    extensionLog('warn', `读取 CPA 代理设置失败: ${e?.message || e}`);
  }
  return cpaProxySettings;
}

async function saveCpaProxySettings({ mode, customUrl, restart = false } = {}) {
  if (!ensureExtensionBridge()) {
    throw new Error('桌面通信通道未就绪');
  }
  const nextMode = String(mode || cpaProxySettings.mode || 'system').toLowerCase();
  const nextCustom = customUrl !== undefined ? String(customUrl || '') : String(cpaProxySettings.customUrl || '');
  const view = await invoke('extension_set_cpa_proxy_settings', {
    mode: nextMode,
    customUrl: nextCustom
  });
  cpaProxySettings = normalizeCpaProxyView(view);
  const effective = cpaProxyEffectiveText(cpaProxySettings);
  extensionLog('info', `CPA 出站代理: ${cpaProxyModeLabel(cpaProxySettings.mode)} → ${effective}`);
  extensionNotify(`已保存代理设置：${cpaProxyModeLabel(cpaProxySettings.mode)}`, 'info');

  if (restart && cpaProxySettings.suiteRunning) {
    extensionNotify('代理已写入配置，正在重启 CPA 使设置生效…', 'info');
    await restartCpaSuite();
    await loadCpaProxySettings();
  } else if (cpaProxySettings.suiteRunning) {
    extensionNotify('代理已写入 config.yaml，请重启 CPA 后生效', 'info');
  }
  return cpaProxySettings;
}

function appendCpaProxySettings(host, service) {
  const current = cpaProxySettings || { mode: 'system', customUrl: '', systemUrl: null, effectiveUrl: '' };
  const wrap = document.createElement('div');
  wrap.className = 'extension-detail-setting-block';

  const head = document.createElement('div');
  head.className = 'extension-detail-setting-row';
  const headCopy = document.createElement('div');
  headCopy.className = 'extension-detail-setting-label';
  const headTitle = document.createElement('strong');
  headTitle.textContent = '出站代理 (proxy-url)';
  const headDesc = document.createElement('span');
  headDesc.textContent = '默认跟随 Windows 系统代理；也可自定义或关闭。修改后需重启 CPA 生效。';
  headCopy.append(headTitle, headDesc);
  head.appendChild(headCopy);
  wrap.appendChild(head);

  const modeRow = document.createElement('div');
  modeRow.className = 'extension-detail-setting-row extension-detail-setting-controls';
  const modeLabel = document.createElement('div');
  modeLabel.className = 'extension-detail-setting-label';
  const modeTitle = document.createElement('strong');
  modeTitle.textContent = '代理模式';
  const modeHint = document.createElement('span');
  modeHint.textContent = current.systemUrl
    ? `当前系统代理：${current.systemUrl}`
    : '当前未检测到系统代理';
  modeLabel.append(modeTitle, modeHint);
  const modeSelect = document.createElement('select');
  modeSelect.className = 'extension-setting-select';
  [
    { value: 'system', label: '跟随系统' },
    { value: 'custom', label: '自定义' },
    { value: 'off', label: '直连' }
  ].forEach((opt) => {
    const option = document.createElement('option');
    option.value = opt.value;
    option.textContent = opt.label;
    if (opt.value === (current.mode || 'system')) option.selected = true;
    modeSelect.appendChild(option);
  });
  modeRow.append(modeLabel, modeSelect);
  wrap.appendChild(modeRow);

  const customRow = document.createElement('div');
  customRow.className = 'extension-detail-setting-row extension-detail-setting-controls';
  const customLabel = document.createElement('div');
  customLabel.className = 'extension-detail-setting-label';
  const customTitle = document.createElement('strong');
  customTitle.textContent = '自定义代理地址';
  const customHint = document.createElement('span');
  customHint.textContent = '例如 socks5://127.0.0.1:7890 或 http://127.0.0.1:7890';
  customLabel.append(customTitle, customHint);
  const customInput = document.createElement('input');
  customInput.type = 'text';
  customInput.className = 'extension-setting-input';
  customInput.placeholder = 'socks5://127.0.0.1:7890';
  customInput.value = current.customUrl || '';
  customInput.spellcheck = false;
  customRow.append(customLabel, customInput);
  wrap.appendChild(customRow);

  const effectiveRow = document.createElement('div');
  effectiveRow.className = 'extension-detail-setting-row';
  const effectiveCopy = document.createElement('div');
  effectiveCopy.className = 'extension-detail-setting-label';
  const effectiveTitle = document.createElement('strong');
  effectiveTitle.textContent = '生效代理';
  const effectiveDesc = document.createElement('span');
  effectiveDesc.textContent = cpaProxyEffectiveText(current);
  effectiveCopy.append(effectiveTitle, effectiveDesc);
  effectiveRow.appendChild(effectiveCopy);
  wrap.appendChild(effectiveRow);

  const actionRow = document.createElement('div');
  actionRow.className = 'extension-detail-setting-row extension-detail-setting-actions';
  const saveBtn = document.createElement('button');
  saveBtn.type = 'button';
  saveBtn.className = 'btn-ghost';
  saveBtn.textContent = '保存代理';
  const saveRestartBtn = document.createElement('button');
  saveRestartBtn.type = 'button';
  saveRestartBtn.className = 'btn-ghost';
  saveRestartBtn.textContent = '保存并重启';
  saveRestartBtn.disabled = !(service?.status === 'running' || current.suiteRunning);
  actionRow.append(saveBtn, saveRestartBtn);
  wrap.appendChild(actionRow);

  const syncCustomEnabled = () => {
    const isCustom = modeSelect.value === 'custom';
    customInput.disabled = !isCustom;
    customRow.style.opacity = isCustom ? '1' : '0.55';
  };
  syncCustomEnabled();
  modeSelect.addEventListener('change', syncCustomEnabled);

  const doSave = async (restart) => {
    saveBtn.disabled = true;
    saveRestartBtn.disabled = true;
    try {
      await saveCpaProxySettings({
        mode: modeSelect.value,
        customUrl: customInput.value,
        restart
      });
      if (activeExtensionDetailId === 'cpa-suite') {
        renderExtensionDetailSettings('cpa-suite', extensionServicesById.get('cpa-suite') || service);
      }
    } catch (e) {
      extensionNotify(`保存代理失败: ${e?.message || e}`, 'error');
      throw e;
    } finally {
      saveBtn.disabled = false;
      saveRestartBtn.disabled = !(service?.status === 'running' || cpaProxySettings.suiteRunning);
    }
  };
  saveBtn.onclick = (event) => {
    event?.stopPropagation?.();
    doSave(false).catch(() => {});
  };
  saveRestartBtn.onclick = (event) => {
    event?.stopPropagation?.();
    doSave(true).catch(() => {});
  };

  host.appendChild(wrap);
}

function renderExtensionDetailSettings(id, service) {
  const section = document.getElementById('extensionDetailSettingsSection');
  const host = document.getElementById('extensionDetailSettings');
  if (!section || !host) return;
  clearExtensionNode(host);

  if (id !== 'cpa-suite') {
    section.hidden = true;
    return;
  }

  section.hidden = false;
  const installDir = service?.installDir || cpaInstallDir || '默认目录';
  appendExtensionSettingToggle(host, {
    label: '跟随软件启动',
    desc: 'AnyBridge 启动时自动拉起已安装的 CPA 套件（默认开启）',
    checked: cpaAutoStart !== false,
    onChange: async (enabled) => {
      await setCpaAutoStart(enabled);
    }
  });
  appendCpaProxySettings(host, service);
  appendExtensionSettingRow(host, {
    label: '安装目录',
    desc: installDir,
    actionLabel: '修改',
    onClick: () => setCpaInstallDir()
  });
  appendExtensionSettingRow(host, {
    label: 'CPA 管理面板',
    desc: '打开 CPA Manager Plus 管理界面',
    actionLabel: '打开',
    onClick: () => handleExtensionAction('open-cpamp')
  });
  appendExtensionSettingRow(host, {
    label: '插件商店',
    desc: '打开 CPA 插件管理页面',
    actionLabel: '打开',
    onClick: () => handleExtensionAction('open-cpamp-plugins')
  });
  appendExtensionSettingRow(host, {
    label: '切换版本',
    desc: '在本地缓存与 GitHub 版本间切换',
    actionLabel: '切换',
    onClick: () => handleExtensionAction('switch-cpa-version')
  });
  appendExtensionSettingRow(host, {
    label: '检测更新',
    desc: '检查 CPA 套件是否有新版本',
    actionLabel: '检测',
    onClick: () => handleExtensionAction('check-cpa-update')
  });
  appendExtensionSettingRow(host, {
    label: '刷新状态',
    desc: '重新检测 CPA 套件运行状态',
    actionLabel: '刷新',
    onClick: () => handleExtensionAction('refresh')
  });
}

function openExtensionDetail(id) {
  const catalog = EXTENSION_CATALOG[id];
  if (!catalog) {
    extensionNotify('扩展详情待接入。', 'info');
    return;
  }
  activeExtensionDetailId = id;
  const service = extensionServicesById.get(id);
  const modal = document.getElementById('extension-detail-modal');
  if (!modal) return;

  const isCpaSettings = id === 'cpa-suite';
  const mark = document.getElementById('extensionDetailMark');
  if (mark) {
    mark.textContent = catalog.short || '扩展';
    mark.className = `extension-detail-mark extension-detail-mark-${id}`;
  }
  const kicker = document.getElementById('extensionDetailKicker');
  if (kicker) kicker.textContent = isCpaSettings ? '扩展设置' : (catalog.kicker || '扩展详情');
  const title = document.getElementById('extensionDetailTitle');
  if (title) title.textContent = isCpaSettings ? `${catalog.name}设置` : catalog.name;
  const desc = document.getElementById('extensionDetailDescription');
  if (desc) {
    desc.textContent = isCpaSettings
      ? '管理 CPA 套件的跟随启动、出站代理、安装目录、面板入口、版本与更新等专属配置。'
      : catalog.description;
  }

  const paint = () => {
    if (activeExtensionDetailId !== id) return;
    renderExtensionDetailSettings(id, service);

    const metrics = document.getElementById('extensionDetailMetrics');
    clearExtensionNode(metrics);
    appendExtensionMetric(metrics, '状态', extensionStatusLabel(service?.status || (id === 'cpa-suite' ? 'checking' : 'not-installed')));
    appendExtensionMetric(metrics, '类型', catalog.type);
    appendExtensionMetric(metrics, '版本', service?.version || '待检测');
    appendExtensionMetric(metrics, '端口', extensionPortsText(service, catalog));
    appendExtensionMetric(metrics, '接入等级', catalog.level);
    appendExtensionMetric(metrics, '来源', service?.installSource || 'GitHub 或手动导入');
    appendExtensionMetric(metrics, '安装目录', service?.installDir || cpaInstallDir || '默认');

    renderExtensionGithubLinks(document.getElementById('extensionDetailGithub'), catalog);
    renderExtensionComponents(document.getElementById('extensionDetailComponents'), service, catalog);
    renderExtensionNotes(document.getElementById('extensionDetailNotes'), service, catalog);
    highlightExtensionDetailAlerts(service);

    const secondary = document.getElementById('extensionDetailSecondaryAction');
    if (secondary) {
      secondary.textContent = catalog.secondaryLabel || '更多';
      secondary.onclick = () => handleExtensionAction(catalog.secondaryAction || 'view-adapter-plan');
    }
    const primary = document.getElementById('extensionDetailPrimaryAction');
    if (primary) {
      let primaryAction = catalog.primaryAction;
      let primaryLabel = catalog.primaryLabel || '执行操作';
      if (id === 'cpa-suite') {
        const status = service?.status || 'not-installed';
        const hasUpdate = cpaUpdateReport?.components?.some(component => component.updateAvailable === true);
        const config = getCpaActionConfig(status, hasUpdate);
        // 设置弹窗内「设置」无意义，降级为刷新
        if (config.primary.action === 'settings' || config.primary.action === 'detail') {
          primaryAction = 'refresh';
          primaryLabel = '刷新状态';
          primary.disabled = false;
        } else {
          primaryAction = config.primary.action || catalog.primaryAction;
          primaryLabel = config.primary.label;
          primary.disabled = Boolean(config.primary.disabled);
        }
      } else {
        primary.disabled = false;
      }
      primary.textContent = primaryLabel;
      primary.onclick = () => {
        if (!primaryAction || primary.disabled) return;
        if (primaryAction === 'settings' || primaryAction === 'detail') return;
        handleExtensionAction(primaryAction);
      };
    }
  };

  if (isCpaSettings) {
    Promise.all([loadCpaAutoStart(), loadCpaProxySettings()]).finally(paint);
  } else {
    paint();
  }

  modal.classList.add('active');
  document.addEventListener('keydown', closeExtensionDetailOnEsc);
}

function closeExtensionDetail() {
  const modal = document.getElementById('extension-detail-modal');
  if (modal) modal.classList.remove('active');
  activeExtensionDetailId = '';
  document.removeEventListener('keydown', closeExtensionDetailOnEsc);
}

function closeExtensionDetailOnEsc(event) {
  if (event.key === 'Escape') closeExtensionDetail();
}

function bindExtensionCardOpeners() {
  // 仅通过「详情/设置」按钮打开弹窗，卡片本体不响应点击
  const modal = document.getElementById('extension-detail-modal');
  if (modal && modal.dataset.overlayBound !== '1') {
    modal.dataset.overlayBound = '1';
    modal.addEventListener('click', event => {
      if (event.target === modal) closeExtensionDetail();
    });
  }
}

function openExtensionLogsFromSettings() {
  closeExtensionSettings();
  switchExtensionTab('logs');
}

// ---- P3 globalThis mirror ----
(function mirrorFns(g) {
  g.loadCpaAutoStart = loadCpaAutoStart;
  g.setCpaAutoStart = setCpaAutoStart;
  g.loadCpaProxySettings = loadCpaProxySettings;
  g.saveCpaProxySettings = saveCpaProxySettings;
  g.appendCpaProxySettings = appendCpaProxySettings;
  g.renderExtensionDetailSettings = renderExtensionDetailSettings;
  g.openExtensionDetail = openExtensionDetail;
  g.closeExtensionDetail = closeExtensionDetail;
  g.closeExtensionDetailOnEsc = closeExtensionDetailOnEsc;
  g.bindExtensionCardOpeners = bindExtensionCardOpeners;
  g.openExtensionLogsFromSettings = openExtensionLogsFromSettings;
})(globalThis);
