// updater/check-and-modal.js — 版本检查、通知中心、版本跳变与更新提示弹窗

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
  if (typeof setLoading === 'function') setLoading(btn, '检查中…');
  else if (btn) btn.disabled = true;
  try {
    await manualCheckUpdate();
    syncNotificationCenter();
  } finally {
    if (typeof clearLoading === 'function') clearLoading(btn);
    else if (btn) {
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

export function logUpdaterEvent(level, message) {
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
  if (typeof setLoading === 'function') setLoading(btn, '检查中…');
  else if (btn) btn.disabled = true;

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
      if (typeof clearLoading === 'function') clearLoading(btn);
    } else {
      detectedUpdateInfo = null;
      syncNotificationCenter();
      logUpdaterEvent('info', '检查更新完成，当前已是最新版本');
      addLog('info', '检查更新完成，当前已是最新版本');
      if (typeof clearLoading === 'function') clearLoading(btn);
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
    if (typeof clearLoading === 'function') clearLoading(btn);
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
    if (btn && btn.dataset?.prevHtml != null && typeof clearLoading === 'function') {
      clearLoading(btn);
    } else if (btn) {
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
globalThis.autoCheckInFlight = false;
async function autoCheckUpdate() {
  if (!invoke || !updateSettings.auto_check) return;
  if (autoCheckInFlight) return; // 防重入：上一次检查未完成时不叠加（借鉴 Cockpit-Tools）
  autoCheckInFlight = true;
  try {
    await runAutoCheckUpdate();
  } finally {
    autoCheckInFlight = false;
  }
}

async function runAutoCheckUpdate() {

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

// ---- P3 globalThis mirror ----
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
})(globalThis);
