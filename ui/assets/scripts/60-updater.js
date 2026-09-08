// ES module (P3) — vars on globalThis; functions kept + mirrored for hoist + data-action.
// ═══════ AUTO UPDATE SYSTEM ═══════
globalThis.updateSettings = {
  auto_check: true,
  last_check_time: 0,
  check_interval_hours: 1,
  auto_install: false,
  last_run_version: '',
  remind_on_update: true,
  skipped_version: ''
};
globalThis.detectedUpdateInfo = null;

function formatUpdaterTargetVersion(update) {
  if (!update) return '';
  return update.version_line_reset ? `v${update.version}（版本线迁移）` : `v${update.version}`;
}

function formatUpdaterNotes(update) {
  const notes = update?.body || '无详细更新说明。';
  if (!update?.version_line_reset) return notes;
  return `这是从历史 1.x 版本线迁移到开源 0.x 版本线的过渡更新。\n\n${notes}`;
}

function currentVersionLabel() {
  return document.getElementById('current-version-display')?.textContent
    || document.getElementById('about-version-display')?.textContent
    || '—';
}

function syncNotificationCenter() {
  const dot = document.getElementById('topbarNotificationDot');
  if (dot) dot.hidden = !detectedUpdateInfo;

  const current = document.getElementById('notificationCurrentVersion');
  if (current) current.textContent = currentVersionLabel();

  const title = document.getElementById('notificationUpdateTitle');
  const desc = document.getElementById('notificationUpdateDesc');
  const notes = document.getElementById('notificationUpdateNotes');
  const notesText = document.getElementById('notificationUpdateNotesText');
  const icon = document.getElementById('notificationUpdateIcon');

  if (detectedUpdateInfo) {
    if (title) title.textContent = `发现 ${formatUpdaterTargetVersion(detectedUpdateInfo)}`;
    if (desc) desc.textContent = '有新的发布版本可用，可以查看说明后前往更新。';
    if (notes) notes.hidden = false;
    if (notesText) notesText.textContent = formatUpdaterNotes(detectedUpdateInfo);
    if (icon) icon.classList.add('has-update');
    return;
  }

  if (title) title.textContent = '暂无新的通知';
  if (desc) {
    const last = updateSettings?.last_check_time
      ? new Date(updateSettings.last_check_time * 1000).toLocaleString()
      : '';
    desc.textContent = last
      ? `最近检查时间：${last}。当前没有检测到可用更新。`
      : '还没有检测到可用更新。你可以手动检查 GitHub 发布页。';
  }
  if (notes) notes.hidden = true;
  if (notesText) notesText.textContent = '';
  if (icon) icon.classList.remove('has-update');
}

function openNotificationCenter() {
  const modal = document.getElementById('notification-center-modal');
  if (!modal) throw new Error('notification-center-modal not found');
  syncNotificationCenter();
  modal.classList.add('active');
  document.addEventListener('keydown', closeNotificationCenterOnEsc);
}

function closeNotificationCenter() {
  const modal = document.getElementById('notification-center-modal');
  if (!modal) throw new Error('notification-center-modal not found');
  modal.classList.remove('active');
  document.removeEventListener('keydown', closeNotificationCenterOnEsc);
}

function closeNotificationCenterOnEsc(event) {
  if (event.key === 'Escape') closeNotificationCenter();
}

async function checkUpdateFromNotificationCenter() {
  const btn = document.getElementById('notificationCheckUpdateBtn');
  if (btn) {
    btn.disabled = true;
    btn.textContent = '检查中...';
  }
  try {
    await manualCheckUpdate();
    syncNotificationCenter();
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = '检查更新';
    }
  }
}

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
  } finally {
    syncNotificationCenter();
  }
}

function logUpdaterEvent(level, message) {
  if (invoke) {
    invoke('update_log', { level, message: String(message) }).catch(() => {});
  }
}

function renderMarkdownNotes(rawNotes) {
  if (!rawNotes) return '<div class="update-notes-paragraph">无详细更新说明。</div>';

  const lines = rawNotes.split(/\r?\n/);
  const htmlParts = [];

  for (let line of lines) {
    line = line.trim();
    if (!line) continue;

    const escaped = line
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');

    // 识别标题 ## 或 ###
    const headerMatch = escaped.match(/^(?:#{1,4})\s*(.*)$/);
    if (headerMatch) {
      const title = headerMatch[1].trim();
      htmlParts.push(`<div class="update-notes-category">${title}</div>`);
      continue;
    }

    // 识别列表项 - 或 *
    const listMatch = escaped.match(/^[-*]\s*(.*)$/);
    if (listMatch) {
      let content = listMatch[1].trim();
      // 转化 `code`
      content = content.replace(/`([^`]+)`/g, '<code class="update-notes-code">$1</code>');
      // 转化 **bold**
      content = content.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
      htmlParts.push(`<div class="update-notes-item">${content}</div>`);
      continue;
    }

    // 普通段落（不带圆点前缀）
    let paragraph = escaped
      .replace(/`([^`]+)`/g, '<code class="update-notes-code">$1</code>')
      .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
    htmlParts.push(`<div class="update-notes-paragraph">${paragraph}</div>`);
  }

  return htmlParts.length > 0 ? htmlParts.join('') : '<div class="update-notes-paragraph">无详细更新说明。</div>';
}

async function patchUpdateSettingField(patch) {
  if (!invoke) return false;
  try {
    const updated = await invoke('patch_update_settings', patch);
    if (updated) {
      updateSettings = updated;
    }
    return true;
  } catch (e) {
    addLog('err', '更新设置失败: ' + e);
    return false;
  }
}

async function saveUpdateSettings() {
  if (!invoke) return false;
  try {
    await invoke('save_update_settings', { settings: updateSettings });
    return true;
  } catch (e) {
    addLog('err', '保存更新配置失败: ' + e);
    if (typeof showCustomAlert === 'function') showCustomAlert(String(e), '保存更新配置失败', 'error');
    return false;
  }
}

async function toggleUpdateSetting(key) {
  const toggleId = 'updater-' + (key === 'remind_on_update' ? 'remind' : key.replace(/_/g, '-'));
  const toggle = document.getElementById(toggleId);
  if (toggle) {
    const nextVal = !toggle.classList.contains('on');
    toggle.classList.toggle('on', nextVal);
    const patch = {};
    patch[key] = nextVal;
    const saved = await patchUpdateSettingField(patch);
    if (!saved) {
      toggle.classList.toggle('on', !nextVal);
    }
  }
}

async function changeUpdateInterval(val) {
  const parsed = parseInt(val);
  if (isNaN(parsed) || parsed < 1) return;
  const previous = updateSettings.check_interval_hours || 1;
  const saved = await patchUpdateSettingField({ check_interval_hours: parsed });
  if (!saved) {
    const input = document.getElementById('updater-check-interval');
    if (input) input.value = previous;
  }
}

// 绑定升级成功弹窗的关闭动作（按钮/遮罩点击/Esc）
function bindUpdateJumpModalHandlers() {
  const modal = document.getElementById('update-jump-modal');
  const closeBtn = document.getElementById('update-jump-close-btn');
  if (!modal) return;
  if (modal.dataset.updateJumpHandlersBound === '1') return;
  modal.dataset.updateJumpHandlersBound = '1';

  if (closeBtn) {
    closeBtn.addEventListener('click', (e) => {
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
      const versionEl = document.getElementById('update-jump-version');
      const descEl = document.getElementById('update-jump-desc');
      const notesEl = document.getElementById('update-jump-notes');

      if (versionEl) versionEl.textContent = 'v' + jump.current_version;
      if (descEl) descEl.textContent = `已从 v${jump.previous_version} 更新到 v${jump.current_version}`;
      if (notesEl) {
        notesEl.textContent = jump.release_notes_zh || jump.release_notes || '本次更新包含性能优化与稳定性提升。';
      }

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



function updateModalVersionDisplay(update) {
  const targetVersionEl = document.getElementById('updater-target-version');
  const versionDescEl = document.getElementById('updater-version-desc');
  const targetNotesEl = document.getElementById('updater-target-notes');
  const currentVer = currentVersionLabel() || '—';
  const displayCurrent = currentVer.startsWith('v') ? currentVer : `v${currentVer}`;

  if (targetVersionEl) {
    targetVersionEl.textContent = formatUpdaterTargetVersion(update);
  }
  if (versionDescEl) {
    versionDescEl.textContent = update.version_line_reset
      ? '这是版本线迁移，新版本已可用。'
      : `当前版本 ${displayCurrent}，新版本已可用。`;
  }
  if (targetNotesEl) {
    targetNotesEl.innerHTML = renderMarkdownNotes(formatUpdaterNotes(update));
  }
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
    logUpdaterEvent('info', '用户手动触发检查更新');
    const update = await invoke('check_for_update');
    await invoke('update_last_check_time').catch(() => {});

    if (update) {
      detectedUpdateInfo = update;
      syncNotificationCenter();
      updateModalVersionDisplay(update);

      // 重置状态
      isDownloading = false;
      updaterRetryCount = 0;
      setUpdaterUIState('available');

      document.getElementById('updater-prompt-modal').classList.add('active');
      logUpdaterEvent('info', `检测到新版本: v${update.version}`);
      addLog('info', update.version_line_reset
        ? `检测到版本线迁移: v${update.version}`
        : `检测到新版本: v${update.version}`);
    } else {
      detectedUpdateInfo = null;
      syncNotificationCenter();
      logUpdaterEvent('info', '检查更新完成，当前已是最新版本');
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
    logUpdaterEvent('error', `手动检查更新失败: ${e}`);
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
    syncNotificationCenter();
  }
}

function closeUpdaterPromptModal() {
  document.getElementById('updater-prompt-modal').classList.remove('active');
}

async function skipThisVersion() {
  if (detectedUpdateInfo) {
    const versionToSkip = detectedUpdateInfo.version;
    await patchUpdateSettingField({ skipped_version: versionToSkip });
    logUpdaterEvent('info', `用户选择跳过版本: v${versionToSkip}`);
    addLog('info', `已跳过版本 v${versionToSkip}`);
  }
  closeUpdaterPromptModal();
}

// 自动后台静默检查
async function autoCheckUpdate() {
  if (!invoke || !updateSettings.auto_check) return;

  try {
    const shouldCheck = await invoke('should_check_updates');
    if (!shouldCheck) return;
  } catch {
    const now = Math.floor(Date.now() / 1000);
    const diff = now - (updateSettings.last_check_time || 0);
    const intervalSec = (updateSettings.check_interval_hours || 1) * 3600;
    if (diff < intervalSec) return;
  }

  try {
    logUpdaterEvent('info', '触发后台自动更新检查');
    const update = await invoke('check_for_update');
    await invoke('update_last_check_time').catch(() => {});

    if (update) {
      if (updateSettings.skipped_version === update.version) {
        console.log('[Updater] Version skipped:', update.version);
        detectedUpdateInfo = null;
        syncNotificationCenter();
        return;
      }

      detectedUpdateInfo = update;
      syncNotificationCenter();

      if (updateSettings.auto_install) {
        // 后台静默下载，不 relaunch，等下次重启生效
        addLog('info', update.version_line_reset
          ? `[后台自动更新] 检测到版本线迁移 v${update.version}，开始后台静默下载...`
          : `[后台自动更新] 检测到新版本 v${update.version}，开始后台静默下载...`);
        try {
          await invoke('download_and_install_update', { relaunch: false });
          addLog('ok', update.version_line_reset
            ? `[后台自动更新] 迁移版本 v${update.version} 已静默下载并安装完成，待下次重启应用时生效！`
            : `[后台自动更新] 新版本 v${update.version} 已静默下载并安装完成，待下次重启应用时生效！`);
        } catch (e) {
          addLog('err', `[后台自动更新] 下载失败: ${e}`);
        }
      } else if (updateSettings.remind_on_update) {
        // 弹出前台提示
        updateModalVersionDisplay(update);

        // 重置状态
        isDownloading = false;
        updaterRetryCount = 0;
        setUpdaterUIState('available');

        document.getElementById('updater-prompt-modal').classList.add('active');
      }
    } else {
      detectedUpdateInfo = null;
      syncNotificationCenter();
    }
  } catch (e) {
    console.error('Auto check update failed:', e);
    // 自动检查失败：通知后端按 5/10/20/40 分钟指数退避（借鉴 Cherry Studio），
    // 避免固定间隔反复请求失败的更新源；手动检查不受影响
    try { await invoke('mark_check_failed'); } catch {}
  }
}

// 点击立即更新开始下载
globalThis.isDownloading = false;
globalThis.updaterRetryCount = 0;
globalThis.UPDATER_MAX_RETRIES = 3;
globalThis.UPDATER_RETRY_DELAYS = [1000, 2500, 5000]; // 指数退避

// 下载页 URL
globalThis.UPDATER_DOWNLOAD_PAGE = 'https://github.com/soulvon/AnyBridge/releases/latest';

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
  const titleText = document.getElementById('updater-modal-title-text');

  [progress, ready, error, retry].forEach(el => { if (el) el.style.display = 'none'; });

  const isVersionReset = !!detectedUpdateInfo?.version_line_reset;
  if (titleText) {
    titleText.textContent = isVersionReset ? '版本线迁移' : '发现新版本';
  }

  if (state === 'available') {
    const barEl = document.getElementById('updater-progress-bar');
    const textEl = document.getElementById('updater-progress-text');
    if (barEl) barEl.style.width = '0%';
    if (textEl) textEl.textContent = '下载中... 0%';

    if (footer) footer.innerHTML = `
      <button data-action="closeUpdaterPromptModal" class="update-btn update-btn-secondary">取消</button>
      <button data-action="skipThisVersion" class="update-btn update-btn-secondary">跳过此版本</button>
      <button data-action="startDownloadAndUpdate" class="update-btn update-btn-primary" id="updater-confirm-btn">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
          <polyline points="7 10 12 15 17 10"></polyline>
          <line x1="12" y1="15" x2="12" y2="3"></line>
        </svg>
        <span>${isVersionReset ? '安装迁移版本' : '立即更新'}</span>
      </button>
    `;
  } else if (state === 'downloading') {
    if (progress) progress.style.display = 'block';
    if (footer) footer.innerHTML = `
      <button data-action="closeUpdaterPromptModal" class="update-btn update-btn-secondary">稍后</button>
      <button class="update-btn update-btn-primary" disabled id="updater-downloading-btn">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" class="spin">
          <path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"></path>
        </svg>
        <span>下载中...</span>
      </button>
    `;
  } else if (state === 'retrying') {
    if (retry) retry.style.display = 'flex';
    if (progress) progress.style.display = 'block';
    if (footer) footer.innerHTML = `
      <button data-action="closeUpdaterPromptModal" class="update-btn update-btn-secondary">稍后</button>
      <button class="update-btn update-btn-primary" disabled id="updater-downloading-btn">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" class="spin">
          <path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"></path>
        </svg>
        <span>重试中...</span>
      </button>
    `;
  } else if (state === 'ready') {
    if (ready) ready.style.display = 'flex';
    const readyText = document.getElementById('updater-ready-text');
    if (readyText) {
      const ver = detectedUpdateInfo?.version ? `v${detectedUpdateInfo.version} ` : '';
      readyText.textContent = `${ver}已就绪，重启后生效。`;
    }
    if (footer) footer.innerHTML = `
      <button data-action="closeUpdaterPromptModal" class="update-btn update-btn-secondary">稍后</button>
      <button data-action="skipThisVersion" class="update-btn update-btn-secondary">跳过此版本</button>
      <button data-action="restartToUpdate" class="update-btn update-btn-primary">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"></path>
        </svg>
        <span>立即重启</span>
      </button>
    `;
  } else if (state === 'error') {
    if (error) error.style.display = 'block';
    if (footer) footer.innerHTML = `
      <button data-action="closeUpdaterPromptModal" class="update-btn update-btn-secondary">关闭</button>
      <button data-action="retryUpdateDownload" class="update-btn update-btn-secondary" style="color: var(--accent);">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"></path>
        </svg>
        <span>重试</span>
      </button>
      <button data-action="openDownloadPage" class="update-btn update-btn-primary">前往发布页</button>
    `;
  } else if (state === 'retrying') {
    if (retry) retry.style.display = 'flex';
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
  // 注意：Tauri updater 无取消 API，后端下载会继续并完成安装（静默生效）。
  // 这里只是切换 UI 并如实告知用户：下载转入后台、代理已暂停、重启后生效。
  isDownloading = false;
  updaterRetryCount = 0;
  const barEl = document.getElementById('updater-progress-bar');
  const textEl = document.getElementById('updater-progress-text') || document.getElementById('updater-progress-percent');
  if (barEl) barEl.style.width = '0%';
  if (textEl) textEl.textContent = '下载中... 0%';
  logUpdaterEvent('info', '用户选择稍后：更新将在后台继续，完成后重启应用生效（本地代理已暂停）');
  addLog('info', '更新转入后台继续，完成后重启 AnyBridge 生效（本地代理已随更新暂停）');
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
    logUpdaterEvent('info', '用户点击立即重启，触发应用重启');
    await invoke('restart_app');
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

      const percentEl = document.getElementById('updater-progress-text') || document.getElementById('updater-progress-percent');
      const barEl = document.getElementById('updater-progress-bar');
      const downloadingBtn = document.getElementById('updater-downloading-btn');

      if (percentEl) percentEl.textContent = `下载中... ${percent}%`;
      if (barEl) barEl.style.width = percent + '%';
      if (downloadingBtn) {
        const span = downloadingBtn.querySelector('span');
        if (span) span.textContent = `下载中... ${percent}%`;
      }
    });

    unlistenComplete = await tauriEvent.listen('update-download-complete', () => {
      if (!isDownloading) return; // 用户已选择"稍后"，避免取消后仍打出成功日志
      addLog('ok', '更新包下载完成！');
    });
  }

  try {
    let success = false;
    let lastError = null;

    for (let attempt = 0; attempt <= UPDATER_MAX_RETRIES; attempt++) {
      if (!isDownloading) break;

      if (attempt > 0) {
        updaterRetryCount = attempt;
        const delay = UPDATER_RETRY_DELAYS[Math.min(attempt - 1, UPDATER_RETRY_DELAYS.length - 1)];
        const retryStatus = document.getElementById('updater-retry-status');
        if (retryStatus) retryStatus.textContent = `网络异常，第 ${attempt}/${UPDATER_MAX_RETRIES} 次重试（${delay / 1000}s 后）...`;
        setUpdaterUIState('retrying');

        await new Promise(r => setTimeout(r, delay));
        if (!isDownloading) break;
        setUpdaterUIState('downloading');
      }

      try {
        if (attempt === 0) {
          addLog('info', '正在下载更新包，请稍候...');
          logUpdaterEvent('info', '开始下载更新包...');
        } else {
          addLog('info', `第 ${attempt} 次重试下载更新包...`);
          logUpdaterEvent('info', `第 ${attempt} 次重试下载更新包...`);
        }

        await invoke('download_and_install_update', { relaunch: false });
        success = true;
        break;
      } catch (err) {
        lastError = err;
        const errMsg = String(err || '未知错误');
        logUpdaterEvent('warn', `更新下载尝试失败 (${attempt + 1}/${UPDATER_MAX_RETRIES + 1}): ${errMsg}`);
        if (!isRetryableUpdateError(err) || attempt >= UPDATER_MAX_RETRIES) {
          break;
        }
      }
    }

    if (success) {
      // 后端已在下载前保存 pending notes，这里不再重复写盘
      if (!isDownloading) {
        // 用户已选"稍后"：安装仍在后台完成了，不打扰弹窗，只提示待重启生效
        logUpdaterEvent('info', '后台更新安装完成，重启应用后生效');
        addLog('ok', '更新已在后台完成，重启 AnyBridge 后生效');
      } else {
        isDownloading = false;
        updaterRetryCount = 0;
        logUpdaterEvent('info', '更新包下载并安装完成，等待重启');
        setUpdaterUIState('ready');
        addLog('ok', '更新包已下载并安装就绪，等待重启生效');
      }
    } else if (isDownloading) {
      isDownloading = false;
      const errMsg = String(lastError || '未知错误');
      logUpdaterEvent('error', `更新下载最终失败: ${errMsg}`);
      addLog('err', '更新下载失败: ' + errMsg);

      const userMsg = errMsg.includes('signature') || errMsg.includes('checksum') || errMsg.includes('hash')
        ? '更新包签名验证失败，请前往下载页手动下载'
        : errMsg.includes('no matching platform')
        ? '当前平台暂不支持自动更新，请手动下载'
        : /\b(404|503)\b/.test(errMsg)
        ? '更新清单尚未就绪（可能正在发布中），请稍后重试'  // 借鉴 Cherry Studio：识别发布窗口期错误
        : '自动更新失败，可重试或前往下载页手动更新';
      showUpdaterError(userMsg, errMsg);
      setUpdaterUIState('error');
      // 失败时后台代理已被暂停以释放更新文件占用，明确告知恢复方式
      logUpdaterEvent('warn', '更新失败：本地代理已暂停，重启 AnyBridge 后自动恢复');
      addLog('warn', '更新失败：本地代理已暂停，重启 AnyBridge 后自动恢复');
    }
  } finally {
    isDownloading = false;
    if (typeof unlistenProgress === 'function') {
      try { unlistenProgress(); } catch {}
    }
    if (typeof unlistenComplete === 'function') {
      try { unlistenComplete(); } catch {}
    }
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
    toggleProxy(btn.dataset.proxyAction || 'toggle').catch(err => {
      _diag('toggleProxy error: ' + err);
      addLog('err', '代理操作异常: ' + err);
    });
  };
  btn.addEventListener('click', handler);
  _diag('proxyBtn handler bound (click)');
}

// ---- P3 globalThis mirror (functions/classes) ----
(function mirrorFns(g) {
  g.formatUpdaterTargetVersion = formatUpdaterTargetVersion;
  g.formatUpdaterNotes = formatUpdaterNotes;
  g.currentVersionLabel = currentVersionLabel;
  g.syncNotificationCenter = syncNotificationCenter;
  g.openNotificationCenter = openNotificationCenter;
  g.closeNotificationCenter = closeNotificationCenter;
  g.closeNotificationCenterOnEsc = closeNotificationCenterOnEsc;
  g.checkUpdateFromNotificationCenter = checkUpdateFromNotificationCenter;
  g.loadUpdateSettings = loadUpdateSettings;
  g.saveUpdateSettings = saveUpdateSettings;
  g.toggleUpdateSetting = toggleUpdateSetting;
  g.changeUpdateInterval = changeUpdateInterval;
  g.bindUpdateJumpModalHandlers = bindUpdateJumpModalHandlers;
  g.checkVersionJump = checkVersionJump;
  g.closeUpdateJumpModal = closeUpdateJumpModal;
  g.manualCheckUpdate = manualCheckUpdate;
  g.closeUpdaterPromptModal = closeUpdaterPromptModal;
  g.skipThisVersion = skipThisVersion;
  g.autoCheckUpdate = autoCheckUpdate;
  g.isRetryableUpdateError = isRetryableUpdateError;
  g.setUpdaterUIState = setUpdaterUIState;
  g.showUpdaterError = showUpdaterError;
  g.toggleUpdaterErrorDetails = toggleUpdaterErrorDetails;
  g.cancelUpdateDownload = cancelUpdateDownload;
  g.retryUpdateDownload = retryUpdateDownload;
  g.openDownloadPage = openDownloadPage;
  g.restartToUpdate = restartToUpdate;
  g.startDownloadAndUpdate = startDownloadAndUpdate;
  g.bindProxyButtonHandlers = bindProxyButtonHandlers;
})(globalThis);
