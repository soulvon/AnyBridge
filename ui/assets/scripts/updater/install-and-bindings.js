// updater/install-and-bindings.js — 安装下载重试、状态展示与代理按钮绑定
import { logUpdaterEvent } from './check-and-modal.js';

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
  // 这里只是切换 UI 并如实告知用户：下载转入后台、网关已暂停、重启后生效。
  isDownloading = false;
  updaterRetryCount = 0;
  const barEl = document.getElementById('updater-progress-bar');
  const textEl = document.getElementById('updater-progress-text') || document.getElementById('updater-progress-percent');
  if (barEl) barEl.style.width = '0%';
  if (textEl) textEl.textContent = '下载中... 0%';
  logUpdaterEvent('info', '用户选择稍后：更新将在后台继续，完成后重启应用生效（本地网关已暂停）');
  addLog('info', '更新转入后台继续，完成后重启 AnyBridge 生效（本地网关已随更新暂停）');
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
      logUpdaterEvent('warn', '更新失败：本地网关已暂停，重启 AnyBridge 后自动恢复');
      addLog('warn', '更新失败：本地网关已暂停，重启 AnyBridge 后自动恢复');
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
      addLog('err', '网关操作异常: ' + err);
    });
  };
  btn.addEventListener('click', handler);
  _diag('proxyBtn handler bound (click)');
}

// ---- P3 globalThis mirror ----
(function mirrorFns(g) {
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
