// extensions/cpa-updates.js — 扩展状态定时探测、自动更新检查与升级执行

let lastRecordedCpaStatus = null;
let lastRecordedComponentsSummary = '';

async function refreshExtensionStatuses(options = {}) {
  const silent = Boolean(options.silent);
  const auto = Boolean(options.auto);
  if (extensionDeployInProgress && auto) {
    scheduleExtensionAutoRefresh('degraded');
    return;
  }
  if (!ensureExtensionBridge()) {
    const message = '桌面通信通道未就绪，无法读取扩展状态。';
    if (!auto) extensionLog('err', message);
    setExtensionStatusBadge(document.getElementById('extension-cpa-status'), 'error');
    renderCpaActions('error', false, false);
    renderCpaAlert({ status: 'error', notes: [message] });
    scheduleExtensionAutoRefresh('error');
    if (!silent && typeof showCustomAlert === 'function') showCustomAlert(message, '扩展状态检测失败', 'error');
    return;
  }

  if (!silent && !auto) extensionLog('info', '正在刷新扩展状态...');
  // 自动刷新不闪「检测中」，避免卡片跳动
  if (!silent && !auto) {
    setExtensionStatusBadge(document.getElementById('extension-cpa-status'), 'checking');
    renderCpaActions('checking', false, false);
  }
  try {
    const services = await invoke('extension_list_managed_services');
    const list = Array.isArray(services) ? services : [];
    extensionServicesById = new Map(list.map(service => [service.id, service]));
    updateExtensionsMetric(list);
    updateCpaSuiteCard(extensionServicesById.get('cpa-suite'));

    const cpa = extensionServicesById.get('cpa-suite');
    const cpaStatus = cpa?.status || 'error';
    const components = Array.isArray(cpa?.components) ? cpa.components : [];
    const ports = components.filter(c => c.port).map(c => `:${c.port}`).join(' / ') || '无端口';
    const compSummary = components.map(c => `${c.name || c.id}:${c.status}:${c.httpStatus || ''}`).join(',');

    const statusChanged = lastRecordedCpaStatus !== cpaStatus || lastRecordedComponentsSummary !== compSummary;
    const isInitial = lastRecordedCpaStatus === null;

    if (!silent || statusChanged) {
      lastRecordedCpaStatus = cpaStatus;
      lastRecordedComponentsSummary = compSummary;

      if (cpaStatus === 'running') {
        extensionLog('ok', `${isInitial ? '服务巡检就绪' : '扩展状态变更'}：CPA 套件处于【运行中】，版本【${cpa?.version || '最新'}】，端口 ${ports}`);
        components.forEach(comp => {
          if (comp.name) {
            const isOk = comp.status === 'running';
            const stateText = isOk ? '响应正常' : comp.status === 'degraded' ? '异常' : comp.status === 'stopped' ? '未监听' : comp.status;
            const httpText = comp.httpStatus ? ` (HTTP ${comp.httpStatus})` : '';
            const portText = comp.port ? ` :${comp.port}` : '';
            extensionLog(isOk ? 'ok' : 'warn', `组件健康检查：${comp.name}${portText} -> ${stateText}${httpText}`);
          }
        });
      } else if (cpaStatus === 'installed') {
        extensionLog('info', `${isInitial ? '服务巡检完成' : '扩展状态变更'}：CPA 套件【已安装未运行】，等待手动启动`);
      } else if (cpaStatus === 'not-installed') {
        extensionLog('info', `${isInitial ? '服务巡检完成' : '扩展状态变更'}：CPA 套件【未安装】`);
      } else if (cpaStatus === 'degraded') {
        extensionLog('warn', `${isInitial ? '服务巡检告警' : '扩展状态变更'}：CPA 套件【部分组件异常】，端口 ${ports}，详情：${cpa?.detail || '等待恢复'}`);
      } else if (cpaStatus === 'error') {
        extensionLog('err', `服务巡检失败：CPA 套件检测异常`);
      }
    }

    if (activeExtensionDetailId) openExtensionDetail(activeExtensionDetailId);
  } catch (e) {
    const message = String(e?.message || e);
    setExtensionStatusBadge(document.getElementById('extension-cpa-status'), 'error');
    renderCpaActions('error', false, false);
    renderCpaAlert({ status: 'error', notes: [`扩展状态刷新失败: ${message}`] });
    scheduleExtensionAutoRefresh('error');
    if (!auto) extensionLog('err', `扩展状态刷新失败: ${message}`);
    if (!silent && typeof showCustomAlert === 'function') showCustomAlert(message, '扩展状态检测失败', 'error');
  }
}

function formatUpdateLine(component) {
  const current = component.currentVersion || '当前版本未知';
  const latest = component.latestVersion || '未知';
  const suffix = component.updateAvailable === true
    ? '可更新'
    : component.updateAvailable === false
      ? '已是最新'
      : '无法比较';
  return `${component.name}：${current} 更新为 ${latest}（${suffix}）`;
}

globalThis.cpaUpdateChecking = false;

async function checkCpaExtensionUpdates(opts = false) {
  const options = typeof opts === 'boolean' ? { autoUpdate: opts } : (opts || {});
  const silent = Boolean(options.silent);
  const autoUpdate = Boolean(options.autoUpdate);

  if (!ensureExtensionBridge()) {
    const message = '桌面通信通道未就绪，无法检测 CPA 更新。';
    if (!silent) {
      extensionLog('err', message);
      if (typeof showCustomAlert === 'function') showCustomAlert(message, 'CPA 更新检测失败', 'error');
    }
    return;
  }

  if (extensionDeployInProgress && silent) {
    return;
  }

  const service = extensionServicesById.get('cpa-suite');
  if (silent) {
    if (!service?.installed) return;
    const alreadyHasUpdate = cpaUpdateReport?.components?.some(component => component.updateAvailable === true);
    if (alreadyHasUpdate) return;
  }

  if (cpaUpdateChecking) return;
  cpaUpdateChecking = true;

  if (!silent) {
    // 手动触发时显示检测中状态：禁用按钮并更改文字
    setCpaSuiteTransientStatus('checking');
    extensionLog('info', '正在检查 CPA 套件的 GitHub 最新发布包...');
  }

  try {
    const report = await invoke('extension_check_cpa_updates');
    cpaUpdateReport = report || null;
    const components = Array.isArray(report?.components) ? report.components : [];
    const hasUpdateNow = components.some(component => component.updateAvailable === true);
    const unknown = components.some(component => component.updateAvailable === null || component.updateAvailable === undefined);
    const lines = components.map(formatUpdateLine);

    if (hasUpdateNow || !silent) {
      extensionLog(hasUpdateNow ? 'warn' : 'ok', `CPA 更新检测完成: ${lines.join('；')}`);
    }
    updateCpaSuiteCard(extensionServicesById.get('cpa-suite'));

    if (autoUpdate && hasUpdateNow) {
      await updateCpaSuite();
      return;
    }

    if (!silent) {
      if (!hasUpdateNow) {
        if (typeof showCustomAlert === 'function') {
          const body = `${lines.join('\n')}\n\n检测时间: ${report?.checkedAt || '未知'}`;
          showCustomAlert(body, 'CPA 套件更新检测', unknown ? 'info' : 'success');
        }
        return;
      }

      if (typeof showCustomConfirm === 'function') {
        const confirmed = await showCustomConfirm(
          `${lines.join('\n')}\n\n将停止服务、下载并覆盖安装（服务会短暂中断）。是否立即更新？`,
          'CPA 套件有新版本',
          'warn'
        );
        if (confirmed) {
          await updateCpaSuite({ skipConfirm: true });
        }
        return;
      }

      if (typeof showCustomAlert === 'function') {
        const body = `${lines.join('\n')}\n\n检测时间: ${report?.checkedAt || '未知'}`;
        showCustomAlert(body, 'CPA 套件更新检测', 'warn');
      }
      return;
    }
  } catch (e) {
    const message = String(e?.message || e);
    if (!silent) {
      extensionLog('err', `CPA 更新检测失败: ${message}`);
      if (typeof showCustomAlert === 'function') showCustomAlert(message, 'CPA 更新检测失败', 'error');
    } else {
      console.warn('[Extensions] CPA 自动更新检测失败 (静默跳过):', message);
    }
  } finally {
    cpaUpdateChecking = false;
    // 恢复按钮到实际状态
    updateCpaSuiteCard(extensionServicesById.get('cpa-suite'));
  }
}

async function stopCpaSuite() {
  if (!ensureExtensionBridge()) {
    extensionLog('err', '桌面通信通道未就绪，无法停止 CPA 套件。');
    return;
  }
  setCpaSuiteTransientStatus('stopping');
  extensionLog('warn', '正在停止 CPA 套件...');
  try {
    await invoke('extension_stop_cpa_suite');
    extensionLog('ok', 'CPA 套件已停止，本地子进程已退出，监听端口已释放。');
    extensionNotify('CPA 套件已停止。', 'info');
  } catch (e) {
    const message = String(e?.message || e);
    extensionLog('err', `停止 CPA 套件失败: ${message}`);
    extensionNotify(`停止失败: ${message}`, 'error');
  } finally {
    await refreshExtensionStatuses({ silent: true });
  }
}

async function startCpaSuite() {
  if (!ensureExtensionBridge()) {
    extensionLog('err', '桌面通信通道未就绪，无法启动 CPA 套件。');
    return;
  }
  setCpaSuiteTransientStatus('starting');
  extensionLog('info', '正在启动 CPA 套件...');
  try {
    await invoke('extension_start_cpa_suite');
    extensionLog('ok', 'CPA 套件启动成功，服务已监听在端口 8317 / 18317。');
    extensionNotify('CPA 套件已启动', 'success');
  } catch (e) {
    const message = String(e?.message || e);
    extensionLog('err', `启动 CPA 套件失败: ${message}`);
    extensionNotify(`启动失败: ${message}`, 'error');
  } finally {
    await refreshExtensionStatuses({ silent: true });
  }
}

async function uninstallCpaSuite() {
  if (!ensureExtensionBridge()) {
    extensionLog('err', '桌面通信通道未就绪，无法卸载 CPA 套件。');
    return;
  }
  const confirmed = await showCustomConfirm(
    '将停止服务并删除当前托管安装目录下的扩展文件（版本目录、installed.json、secrets 等）。不会删除桌面 CPA 导入源。此操作不可撤销。确定卸载？',
    '卸载 CPA 套件',
    'warn'
  );
  if (!confirmed) return;
  setCpaSuiteTransientStatus('uninstalling');
  extensionLog('warn', '正在卸载 CPA 套件...');
  try {
    await invoke('extension_uninstall_cpa_suite');
    cpaUpdateReport = null;
    await loadCpaInstallDir();
    await refreshExtensionStatuses({ silent: true });
    try {
      if (typeof loadProviders === 'function') await loadProviders();
      if (typeof renderProviders === 'function') renderProviders();
      if (typeof renderEvalProviderOptions === 'function') renderEvalProviderOptions();
    } catch (_) {}
    const still = extensionServicesById.get('cpa-suite');
    if (still?.installed || still?.status === 'installed' || still?.status === 'running' || still?.status === 'degraded') {
      extensionNotify('托管目录已清理，但仍检测到桌面等外部安装来源。', 'warn');
      extensionLog('warn', '卸载后仍检测到可扫描的 CPA 安装（例如桌面 CPA 目录），不会自动删除外部目录。');
    } else {
      extensionLog('ok', 'CPA 套件已成功卸载，本地托管文件与配置已清理完成。');
      extensionNotify('CPA 套件已卸载', 'info');
    }
  } catch (e) {
    const message = String(e?.message || e);
    extensionLog('err', `卸载 CPA 套件失败: ${message}`);
    extensionNotify(`卸载失败: ${message}`, 'error');
    await refreshExtensionStatuses({ silent: true });
  }
}

async function restartCpaSuite() {
  if (!ensureExtensionBridge()) {
    extensionLog('err', '桌面通信通道未就绪，无法重启 CPA 套件。');
    return;
  }
  setCpaSuiteTransientStatus('starting', '重启中');
  extensionLog('warn', '正在执行 CPA 套件重启...');
  try {
    await invoke('extension_restart_cpa_suite');
    extensionLog('ok', 'CPA 套件重启成功，所有组件端口健康检查已通过 (8317 / 18317)。');
    extensionNotify('CPA 套件已重启', 'success');
  } catch (e) {
    const message = String(e?.message || e);
    extensionLog('err', `重启 CPA 套件失败: ${message}`);
    extensionNotify(`重启失败: ${message}`, 'error');
  } finally {
    await refreshExtensionStatuses({ silent: true });
  }
}

async function updateCpaSuite(opts = {}) {
  const options = typeof opts === 'boolean' ? { skipConfirm: opts } : (opts || {});
  const skipConfirm = Boolean(options.skipConfirm);

  if (!ensureExtensionBridge()) {
    extensionLog('err', '桌面通信通道未就绪，无法更新 CPA 套件。');
    return;
  }
  if (!cpaUpdateReport?.components?.some(component => component.updateAvailable === true)) {
    await checkCpaExtensionUpdates();
    return;
  }

  if (!skipConfirm) {
    const confirmed = typeof showCustomConfirm === 'function'
      ? await showCustomConfirm(
          '检测到新版本，将停止服务、下载并覆盖安装，服务会短暂中断。确定更新？',
          '确认更新 CPA 套件',
          'warn'
        )
      : true;
    if (!confirmed) return;
  }

  const installDir = cpaInstallDir || null;
  setCpaSuiteTransientStatus('updating');
  setCpaProgress(1, '开始更新 CPA 套件...', true);
  extensionLog('warn', '开始更新 CPA 套件...');
  try {
    await invoke('extension_update_cpa_suite', { installDir });
    setCpaProgress(100, '更新完成', true);
    extensionNotify('CPA 套件更新完成！', 'success');
    cpaUpdateReport = null;
  } catch (e) {
    const message = String(e?.message || e);
    extensionLog('err', `CPA 套件更新失败: ${message}`);
    extensionNotify(`更新失败: ${message}`, 'error');
    renderCpaAlert({ status: 'error', notes: [message] });
  } finally {
    await refreshExtensionStatuses({ silent: true });
    if (cpaProgressHideTimer) clearTimeout(cpaProgressHideTimer);
    cpaProgressHideTimer = setTimeout(() => {
      cpaProgressHideTimer = null;
      hideCpaProgress();
    }, 800);
  }
}

let cpaAutoCheckTimer = null;
let cpaAutoCheckInterval = null;
let cpaAutoCheckSeq = 0;
let cpaProgressHideTimer = null;

const CPA_AUTO_CHECK_INITIAL_DELAY_MS = 5 * 60 * 1000; // 启动 5 分钟后首次检查
const CPA_AUTO_CHECK_INTERVAL_MS = 60 * 60 * 1000;       // 之后每隔 1 小时检查一次

function stopCpaAutoUpdateScheduler() {
  cpaAutoCheckSeq += 1;
  if (cpaAutoCheckTimer) {
    clearTimeout(cpaAutoCheckTimer);
    cpaAutoCheckTimer = null;
  }
  if (cpaAutoCheckInterval) {
    clearInterval(cpaAutoCheckInterval);
    cpaAutoCheckInterval = null;
  }
}

function startCpaAutoUpdateScheduler() {
  stopCpaAutoUpdateScheduler();
  const seq = cpaAutoCheckSeq;

  cpaAutoCheckTimer = setTimeout(async () => {
    cpaAutoCheckTimer = null;
    if (seq !== cpaAutoCheckSeq) return;
    if (typeof document === 'undefined' || !document.hidden) {
      await checkCpaExtensionUpdates({ silent: true }).catch(() => {});
    }
    if (seq !== cpaAutoCheckSeq) return;
    if (cpaAutoCheckInterval) clearInterval(cpaAutoCheckInterval);
    cpaAutoCheckInterval = setInterval(async () => {
      if (seq !== cpaAutoCheckSeq) return;
      if (typeof document !== 'undefined' && document.hidden) return;
      await checkCpaExtensionUpdates({ silent: true }).catch(() => {});
    }, CPA_AUTO_CHECK_INTERVAL_MS);
  }, CPA_AUTO_CHECK_INITIAL_DELAY_MS);
}

async function initExtensions() {
  bindExtensionCardOpeners();
  bindExtensionSettingsModal();
  bindDeployProgressListener();
  switchExtensionTab('installed');
  await Promise.all([
    refreshExtensionStatuses({ silent: true }),
    loadCpaInstallDir(),
    loadCpaAutoStart(),
    loadCpaProxySettings()
  ]);
  startCpaAutoUpdateScheduler();
}

function onExtensionsPageEnter() {
  if (extensionLogEntries.length === 0) {
    extensionLog('info', '扩展中心已就绪，正在检测本地服务状态...');
  }
  if (typeof refreshExtensionStatuses === 'function') {
    refreshExtensionStatuses({ silent: true });
  }
}

function onExtensionsPageLeave() {
  clearExtensionAutoRefresh();
}

async function loadCpaInstallDir() {
  if (!ensureExtensionBridge()) return;
  try {
    cpaInstallDir = await invoke('extension_cpa_install_dir') || null;
    renderCpaInstallDir();
  } catch (e) {
    extensionLog('err', `读取安装目录失败: ${e?.message || e}`);
  }
}

function renderCpaInstallDir() {
  const el = document.getElementById('extension-cpa-install-dir');
  if (el) {
    const label = cpaInstallDir || '默认';
    el.textContent = label;
    el.title = cpaInstallDir || '';
  }
  // 若 CPA 设置弹窗打开中，同步刷新安装目录展示
  if (activeExtensionDetailId === 'cpa-suite') {
    const host = document.getElementById('extensionDetailSettings');
    const rows = host?.querySelectorAll('.extension-detail-setting-row') || [];
    rows.forEach(row => {
      const title = row.querySelector('.extension-detail-setting-label strong')?.textContent || '';
      if (title === '安装目录') {
        const desc = row.querySelector('.extension-detail-setting-label span');
        if (desc) desc.textContent = cpaInstallDir || '默认目录';
      }
    });
  }
}

async function chooseCpaInstallDir() {
  if (!ensureExtensionBridge()) return null;
  const defaultDir = cpaInstallDir || (await invoke('extension_cpa_default_install_dir'));
  if (typeof defaultDir !== 'string') return cpaInstallDir;

  let picked;
  try {
    picked = await invoke('pick_directory', {
      title: '选择 CPA 套件安装目录',
      defaultPath: defaultDir,
    });
  } catch (e) {
    extensionLog('err', `选择文件夹失败: ${e?.message || e}`);
    extensionNotify(`选择文件夹失败: ${e?.message || e}`, 'error');
    return null;
  }
  if (picked === null || picked === undefined) return null; // 用户取消

  const dir = String(picked || '').trim();
  cpaInstallDir = dir || defaultDir;
  renderCpaInstallDir();
  if (dir && dir !== defaultDir) {
    try {
      await invoke('extension_set_cpa_install_dir', { dir });
    } catch (e) {
      extensionLog('warn', `保存安装目录失败: ${e?.message || e}`);
    }
  }
  return cpaInstallDir;
}

/** 部署弹窗内：选择安装目录并写入输入框 */
async function browseCpaDeployDir() {
  if (!ensureExtensionBridge()) return;
  const inputEl = document.getElementById('cpa-deploy-dir-input');
  let defaultDir = cpaInstallDir || '';
  try {
    defaultDir = cpaInstallDir || (await invoke('extension_cpa_default_install_dir'));
  } catch (_) {}
  const current = (inputEl?.value || '').trim() || defaultDir || '';
  try {
    const picked = await invoke('pick_directory', {
      title: '选择 CPA 套件安装目录',
      defaultPath: current,
    });
    if (picked === null || picked === undefined) return;
    if (inputEl) {
      inputEl.value = String(picked || '');
      inputEl.focus();
    }
  } catch (e) {
    extensionLog('err', `选择文件夹失败: ${e?.message || e}`);
    extensionNotify(`选择文件夹失败: ${e?.message || e}`, 'error');
  }
}

async function setCpaInstallDir() {
  const chosen = await chooseCpaInstallDir();
  if (chosen) {
    extensionNotify(`安装目录已设置为 ${chosen}`, 'info');
    extensionLog('info', `CPA 安装目录: ${chosen}`);
  }
}

function toggleExtensionDetails(id, button) {
  const details = document.getElementById(`extension-details-${id}`);
  if (!details) return;
  const willHide = !details.hidden;
  details.hidden = willHide;
  if (button) {
    button.setAttribute('aria-expanded', String(!willHide));
    button.textContent = willHide ? '展开详情' : '收起详情';
  }
}

async function openExtensionURL(url, label) {
  try {
    await invoke('open_url', { url });
    extensionNotify(`已打开 ${label}`, 'info');
    extensionLog('info', `打开链接: ${label} (${url})`);
  } catch (e) {
    extensionLog('err', `打开链接失败: ${e?.message || e}`);
    extensionNotify(`打开链接失败: ${e?.message || e}`, 'error');
  }
}

function showExtensionBackendPending(title, detail) {
  const message = `${detail}\n\n下一步需要接入桌面端命令：下载发布包、解压、生成配置、启动服务、健康检查。`;
  if (typeof showCustomAlert === 'function') {
    showCustomAlert(message, title, 'info');
  } else {
    extensionNotify(detail, 'info');
  }
  extensionLog('warn', `${title}: 后端命令待接入。`);
}

// ---- P3 globalThis mirror ----
(function mirrorFns(g) {
  g.refreshExtensionStatuses = refreshExtensionStatuses;
  g.formatUpdateLine = formatUpdateLine;
  g.checkCpaExtensionUpdates = checkCpaExtensionUpdates;
  g.stopCpaSuite = stopCpaSuite;
  g.startCpaSuite = startCpaSuite;
  g.uninstallCpaSuite = uninstallCpaSuite;
  g.restartCpaSuite = restartCpaSuite;
  g.updateCpaSuite = updateCpaSuite;
  g.stopCpaAutoUpdateScheduler = stopCpaAutoUpdateScheduler;
  g.startCpaAutoUpdateScheduler = startCpaAutoUpdateScheduler;
  g.initExtensions = initExtensions;
  g.onExtensionsPageEnter = onExtensionsPageEnter;
  g.onExtensionsPageLeave = onExtensionsPageLeave;
  g.loadCpaInstallDir = loadCpaInstallDir;
  g.renderCpaInstallDir = renderCpaInstallDir;
  g.chooseCpaInstallDir = chooseCpaInstallDir;
  g.browseCpaDeployDir = browseCpaDeployDir;
  g.setCpaInstallDir = setCpaInstallDir;
  g.toggleExtensionDetails = toggleExtensionDetails;
  g.openExtensionURL = openExtensionURL;
  g.showExtensionBackendPending = showExtensionBackendPending;
})(globalThis);
