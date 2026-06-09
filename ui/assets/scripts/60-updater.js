// ═══════ AUTO UPDATE SYSTEM ═══════
let updateSettings = {
  auto_check: true,
  last_check_time: 0,
  check_interval_hours: 1,
  auto_install: false,
  last_run_version: '',
  remind_on_update: true,
  skipped_version: ''
};
let detectedUpdateInfo = null;

async function loadUpdateSettings() {
  if (!invoke) return;
  try {
    updateSettings = await invoke('get_update_settings');

    // 同步到设置 UI
    const autoCheckToggle = document.getElementById('updater-auto-check');
    const autoInstallToggle = document.getElementById('updater-auto-install');
    const remindToggle = document.getElementById('updater-remind');
    const checkIntervalInput = document.getElementById('updater-check-interval');

    if (autoCheckToggle) autoCheckToggle.classList.toggle('on', !!updateSettings.auto_check);
    if (autoInstallToggle) autoInstallToggle.classList.toggle('on', !!updateSettings.auto_install);
    if (remindToggle) remindToggle.classList.toggle('on', !!updateSettings.remind_on_update);
    if (checkIntervalInput) checkIntervalInput.value = updateSettings.check_interval_hours || 1;
  } catch (e) {
    addLog('err', '加载更新配置失败: ' + e);
  }
}

async function saveUpdateSettings() {
  if (!invoke) return;
  try {
    await invoke('save_update_settings', { settings: updateSettings });
  } catch (e) {
    addLog('err', '保存更新配置失败: ' + e);
  }
}

async function toggleUpdateSetting(key) {
  const toggleId = 'updater-' + (key === 'remind_on_update' ? 'remind' : key.replace(/_/g, '-'));
  const toggle = document.getElementById(toggleId);
  if (toggle) {
    toggle.classList.toggle('on');
    updateSettings[key] = toggle.classList.contains('on');
    await saveUpdateSettings();
  }
}

async function changeUpdateInterval(val) {
  const parsed = parseInt(val);
  if (isNaN(parsed) || parsed < 1) return;
  updateSettings.check_interval_hours = parsed;
  await saveUpdateSettings();
}

// 绑定升级成功弹窗的关闭动作（按钮/遮罩点击/Esc）
function bindUpdateJumpModalHandlers() {
  const modal = document.getElementById('update-jump-modal');
  const closeBtn = document.getElementById('update-jump-close-btn');
  if (!modal) return;

  if (closeBtn) {
    closeBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      closeUpdateJumpModal();
    });
    closeBtn.addEventListener('pointerup', (e) => {
      e.preventDefault();
      e.stopPropagation();
      closeUpdateJumpModal();
    });
  } else {
    _diag('WARN: update-jump-close-btn not found');
  }

  modal.addEventListener('click', (e) => {
    if (e.target === modal) closeUpdateJumpModal();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && modal.classList.contains('active')) {
      closeUpdateJumpModal();
    }
  });
}


// 检查是否刚进行了版本更新
async function checkVersionJump() {
  if (!invoke) return false;
  try {
    const jump = await invoke('check_version_jump');
    if (jump) {
      document.getElementById('update-jump-version').textContent = 'v' + jump.current_version;
      document.getElementById('update-jump-prev-version').textContent = 'v' + jump.previous_version;
      document.getElementById('update-jump-current-version').textContent = 'v' + jump.current_version;
      document.getElementById('update-jump-notes').textContent = jump.release_notes_zh || jump.release_notes || '本次更新包含性能优化与稳定性提升。';

      // 先收起其他同层弹窗，避免遮罩层级冲突导致无法点击
      document.getElementById('updater-prompt-modal')?.classList.remove('active');
      document.getElementById('custom-confirm-modal')?.classList.remove('active');

      document.getElementById('update-jump-modal').classList.add('active');
      addLog('ok', `程序已成功由 v${jump.previous_version} 升级至 v${jump.current_version}！`);
      return true;
    }
  } catch (e) {
    console.error('check version jump error:', e);
  }
  return false;
}

function closeUpdateJumpModal() {
  document.getElementById('update-jump-modal')?.classList.remove('active');
  // 关闭升级成功弹窗后再补做一次自动更新检查
  setTimeout(() => { autoCheckUpdate().catch(() => {}); }, 50);
}



// 手动检查更新
async function manualCheckUpdate() {
  if (!invoke) return;
  const btn = document.getElementById('updater-manual-btn');
  if (btn) {
    btn.disabled = true;
    btn.textContent = '检查中...';
  }

  try {
    addLog('info', '正在连线 GitHub 检查更新...');
    const update = await invoke('check_for_update');

    if (update) {
      detectedUpdateInfo = update;
      document.getElementById('updater-target-version').textContent = 'v' + update.version;
      document.getElementById('updater-target-notes').textContent = update.body || '无详细更新说明。';

      // 重置状态
      isDownloading = false;
      updaterRetryCount = 0;
      setUpdaterUIState('available');

      document.getElementById('updater-prompt-modal').classList.add('active');
      addLog('info', `检测到新版本: v${update.version}`);
    } else {
      addLog('info', '检查更新完成，当前已是最新版本');
      // 在按钮旁显示简短提示
      if (btn) {
        btn.textContent = '✓ 已是最新';
        btn.style.color = 'var(--success)';
        setTimeout(() => {
          btn.textContent = '检查更新';
          btn.style.color = '';
        }, 2500);
      }
    }
  } catch (e) {
    addLog('err', '检查更新失败: ' + e);
    // 在按钮旁显示错误提示
    if (btn) {
      btn.textContent = '检查失败';
      btn.style.color = 'var(--error, #ef4444)';
      setTimeout(() => {
        btn.textContent = '检查更新';
        btn.style.color = '';
      }, 3000);
    }
  } finally {
    if (btn) {
      btn.disabled = false;
    }
  }
}

function closeUpdaterPromptModal() {
  document.getElementById('updater-prompt-modal').classList.remove('active');
}

async function skipThisVersion() {
  if (detectedUpdateInfo) {
    updateSettings.skipped_version = detectedUpdateInfo.version;
    await saveUpdateSettings();
    addLog('info', `已跳过版本 v${detectedUpdateInfo.version}`);
  }
  closeUpdaterPromptModal();
}

// 自动后台静默检查
async function autoCheckUpdate() {
  if (!invoke || !updateSettings.auto_check) return;

  const now = Math.floor(Date.now() / 1000);
  const diff = now - (updateSettings.last_check_time || 0);
  const intervalSec = (updateSettings.check_interval_hours || 1) * 3600;

  if (diff < intervalSec) {
    return; // 未达到轮询周期
  }

  try {
    console.log('[Updater] Auto check triggered...');
    const update = await invoke('check_for_update');
    await invoke('update_last_check_time');

    if (update) {
      if (updateSettings.skipped_version === update.version) {
        console.log('[Updater] Version skipped:', update.version);
        return;
      }

      detectedUpdateInfo = update;

      if (updateSettings.auto_install) {
        // 后台静默下载，不 relaunch，等下次重启生效
        addLog('info', `[后台自动更新] 检测到新版本 v${update.version}，开始后台静默下载...`);
        try {
          await invoke('download_and_install_update', { relaunch: false });
          addLog('ok', `[后台自动更新] 新版本 v${update.version} 已静默下载并安装完成，待下次重启应用时生效！`);
        } catch (e) {
          addLog('err', `[后台自动更新] 下载失败: ${e}`);
        }
      } else if (updateSettings.remind_on_update) {
        // 弹出前台提示
        document.getElementById('updater-target-version').textContent = 'v' + update.version;
        document.getElementById('updater-target-notes').textContent = update.body || '无详细更新说明。';

        // 重置状态
        isDownloading = false;
        updaterRetryCount = 0;
        setUpdaterUIState('available');

        document.getElementById('updater-prompt-modal').classList.add('active');
      }
    }
  } catch (e) {
    console.error('Auto check update failed:', e);
  }
}

// 点击立即更新开始下载
let isDownloading = false;
let updaterRetryCount = 0;
const UPDATER_MAX_RETRIES = 3;
const UPDATER_RETRY_DELAYS = [1000, 2500, 5000]; // 指数退避

// 下载页 URL
const UPDATER_DOWNLOAD_PAGE = 'https://github.com/soulvon/IDE-BYOK-Release/releases';

// 判断是否为可重试的网络错误
function isRetryableUpdateError(err) {
  const msg = String(err || '').toLowerCase();
  const nonRetryable = ['signature', 'checksum', 'hash mismatch', 'no matching platform', 'permission denied', 'no space left', 'disk full'];
  if (nonRetryable.some(h => msg.includes(h))) return false;
  const retryable = ['timeout', 'network', 'dns', 'connection reset', 'connection refused', 'connection aborted', 'broken pipe', 'unexpected eof', 'error sending request', 'failed to send request'];
  return retryable.some(h => msg.includes(h));
}

// 显示/隐藏更新弹窗的各个状态区域
function setUpdaterUIState(state) {
  const progress = document.getElementById('updater-progress-container');
  const ready = document.getElementById('updater-ready-container');
  const error = document.getElementById('updater-error-container');
  const retry = document.getElementById('updater-retry-container');
  const footer = document.getElementById('updater-prompt-footer');
  const icon = document.getElementById('updater-modal-icon');
  const titleText = document.getElementById('updater-modal-title-text');

  [progress, ready, error, retry].forEach(el => { if (el) el.style.display = 'none'; });

  if (state === 'available') {
    titleText.textContent = '检测到新版本可用！';
    icon.style.color = 'var(--accent)';
    if (footer) footer.innerHTML = `
      <button onclick="skipThisVersion()" class="modal-btn modal-btn-cancel" style="font-size: 12px; padding: 10px 16px;">跳过此版本</button>
      <button onclick="closeUpdaterPromptModal()" class="modal-btn modal-btn-cancel" style="font-size: 12px; padding: 10px 16px;">稍后</button>
      <button onclick="startDownloadAndUpdate()" class="modal-btn modal-btn-confirm" style="font-size: 12px; padding: 10px 20px;">立即更新</button>
    `;
  } else if (state === 'downloading') {
    titleText.textContent = '正在下载更新...';
    icon.style.color = 'var(--accent)';
    if (progress) progress.style.display = 'block';
    if (footer) footer.innerHTML = `
      <button onclick="cancelUpdateDownload()" class="modal-btn modal-btn-cancel" style="font-size: 12px; padding: 10px 16px;">取消下载</button>
      <button class="modal-btn modal-btn-confirm" style="font-size: 12px; padding: 10px 20px; opacity: 0.6;" disabled id="updater-downloading-btn">下载中...</button>
    `;
  } else if (state === 'ready') {
    titleText.textContent = '更新已就绪';
    icon.style.color = 'var(--success)';
    if (ready) ready.style.display = 'block';
    if (footer) footer.innerHTML = `
      <button onclick="closeUpdaterPromptModal()" class="modal-btn modal-btn-cancel" style="font-size: 12px; padding: 10px 16px;">稍后重启</button>
      <button onclick="restartToUpdate()" class="modal-btn modal-btn-confirm" style="font-size: 12px; padding: 10px 20px;">立即重启</button>
    `;
  } else if (state === 'error') {
    titleText.textContent = '更新失败';
    icon.style.color = 'var(--error, #ef4444)';
    if (error) error.style.display = 'block';
    if (footer) footer.innerHTML = `
      <button onclick="closeUpdaterPromptModal()" class="modal-btn modal-btn-cancel" style="font-size: 12px; padding: 10px 16px;">关闭</button>
      <button onclick="retryUpdateDownload()" class="modal-btn modal-btn-cancel" style="font-size: 12px; padding: 10px 16px; color: var(--accent);">🔄 重试</button>
      <button onclick="openDownloadPage()" class="modal-btn modal-btn-confirm" style="font-size: 12px; padding: 10px 20px;">前往下载页</button>
    `;
  } else if (state === 'retrying') {
    titleText.textContent = '正在重试...';
    icon.style.color = 'var(--accent)';
    if (retry) retry.style.display = 'block';
  }
}

function showUpdaterError(message, details) {
  const msgEl = document.getElementById('updater-error-message');
  const detailEl = document.getElementById('updater-error-details');
  const toggleEl = document.getElementById('updater-error-toggle');
  if (msgEl) msgEl.textContent = message;
  if (detailEl) detailEl.textContent = details || '';
  if (toggleEl) toggleEl.style.display = details ? 'inline' : 'none';
  if (toggleEl) toggleEl.textContent = '查看详情';
  if (detailEl) detailEl.style.display = 'none';
}

function toggleUpdaterErrorDetails() {
  const detailEl = document.getElementById('updater-error-details');
  const toggleEl = document.getElementById('updater-error-toggle');
  if (!detailEl || !toggleEl) return;
  const visible = detailEl.style.display !== 'none';
  detailEl.style.display = visible ? 'none' : 'block';
  toggleEl.textContent = visible ? '查看详情' : '收起详情';
}

function cancelUpdateDownload() {
  isDownloading = false;
  updaterRetryCount = 0;
  setUpdaterUIState('available');
}

async function retryUpdateDownload() {
  updaterRetryCount = 0;
  await startDownloadAndUpdate();
}

async function openDownloadPage() {
  closeUpdaterPromptModal();
  if (invoke) {
    try { await invoke('open_download_page'); return; } catch {}
  }
  window.open(UPDATER_DOWNLOAD_PAGE, '_blank');
}

async function restartToUpdate() {
  if (!invoke) return;
  try {
    addLog('info', '正在重启应用以完成更新...');
    await invoke('download_and_install_update', { relaunch: true });
  } catch (e) {
    addLog('err', '重启更新失败: ' + e);
    // 如果重启失败，尝试直接 relaunch
    try {
      if (TAURI?.process?.relaunch) { TAURI.process.relaunch(); }
    } catch {}
  }
}

async function startDownloadAndUpdate() {
  if (!invoke || isDownloading) return;
  isDownloading = true;
  updaterRetryCount = 0;

  setUpdaterUIState('downloading');

  // 注册进度事件监听
  let unlistenProgress = null;
  let unlistenComplete = null;

  if (tauriEvent?.listen) {
    unlistenProgress = await tauriEvent.listen('update-download-progress', (e) => {
      if (!isDownloading) return;
      const payload = e.payload || {};
      const percent = payload.percentage ? Math.round(payload.percentage) : 0;

      const percentEl = document.getElementById('updater-progress-percent');
      const barEl = document.getElementById('updater-progress-bar');
      const statusEl = document.getElementById('updater-progress-status');
      const downloadingBtn = document.getElementById('updater-downloading-btn');

      if (percentEl) percentEl.textContent = percent + '%';
      if (barEl) barEl.style.width = percent + '%';
      if (statusEl) statusEl.textContent = `已下载: ${(payload.downloaded / 1024 / 1024).toFixed(2)} MB`;
      if (downloadingBtn) downloadingBtn.textContent = `下载中 (${percent}%)`;
    });

    unlistenComplete = await tauriEvent.listen('update-download-complete', () => {
      addLog('ok', '更新包下载完成！');
    });
  }

  try {
    addLog('info', '正在下载更新包，请稍候...');
    await invoke('download_and_install_update', { relaunch: false });
    // 下载成功，保存更新说明以便下次启动展示
    isDownloading = false;
    if (detectedUpdateInfo) {
      try {
        await invoke('save_pending_update_notes', {
          version: detectedUpdateInfo.version,
          releaseNotes: detectedUpdateInfo.body || '',
          releaseNotesZh: detectedUpdateInfo.body || ''
        });
      } catch (e) { console.warn('save_pending_update_notes failed:', e); }
    }
    setUpdaterUIState('ready');
    addLog('ok', '更新包已下载并安装就绪，等待重启生效');
  } catch (e) {
    isDownloading = false;
    const errMsg = String(e || '未知错误');
    addLog('err', '更新下载失败: ' + errMsg);

    // 判断是否可重试，自动重试
    if (isRetryableUpdateError(e) && updaterRetryCount < UPDATER_MAX_RETRIES) {
      const delay = UPDATER_RETRY_DELAYS[Math.min(updaterRetryCount, UPDATER_RETRY_DELAYS.length - 1)];
      updaterRetryCount++;
      const retryStatus = document.getElementById('updater-retry-status');
      if (retryStatus) retryStatus.textContent = `网络异常，第 ${updaterRetryCount}/${UPDATER_MAX_RETRIES} 次重试（${delay/1000}s 后）...`;
      setUpdaterUIState('retrying');

      await new Promise(r => setTimeout(r, delay));

      if (isDownloading === false && updaterRetryCount > 0) {
        // 没有被取消，继续重试
        isDownloading = true;
        try {
          await invoke('download_and_install_update', { relaunch: false });
          isDownloading = false;
          updaterRetryCount = 0;
          if (detectedUpdateInfo) {
            try {
              await invoke('save_pending_update_notes', {
                version: detectedUpdateInfo.version,
                releaseNotes: detectedUpdateInfo.body || '',
                releaseNotesZh: detectedUpdateInfo.body || ''
              });
            } catch (e) { console.warn('save_pending_update_notes failed:', e); }
          }
          setUpdaterUIState('ready');
          addLog('ok', '重试成功，更新包已就绪');
        } catch (e2) {
          isDownloading = false;
          // 重试也失败了，如果还有次数则递归
          if (updaterRetryCount < UPDATER_MAX_RETRIES) {
            // 继续重试
            await startDownloadAndUpdate();
            return;
          }
          // 重试次数用完，显示错误
          showUpdaterError('自动更新下载失败，可重试或前往下载页手动更新', String(e2));
          setUpdaterUIState('error');
        }
      }
    } else {
      // 不可重试的错误，直接显示错误状态
      const userMsg = errMsg.includes('signature') || errMsg.includes('checksum') || errMsg.includes('hash')
        ? '更新包签名验证失败，请前往下载页手动下载'
        : errMsg.includes('no matching platform')
        ? '当前平台暂不支持自动更新，请手动下载'
        : '自动更新失败，可重试或前往下载页手动更新';
      showUpdaterError(userMsg, errMsg);
      setUpdaterUIState('error');
    }
  } finally {
    if (unlistenProgress) unlistenProgress();
    if (unlistenComplete) unlistenComplete();
  }
}

function bindProxyButtonHandlers() {
  const btn = document.getElementById('proxyBtn');
  if (!btn) {
    _diag('proxyBtn not found');
    return;
  }
  const handler = (e) => {
    e.preventDefault();
    e.stopPropagation();
    toggleProxy().catch(err => {
      _diag('toggleProxy error: ' + err);
      addLog('err', '代理操作异常: ' + err);
    });
  };
  btn.addEventListener('click', handler);
  _diag('proxyBtn handler bound (click)');
}
