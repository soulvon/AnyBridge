// ═══════ INIT ═══════
async function syncAppVersionDisplay() {
  let label = 'v1.2.16';
  try {
    const v = await invoke('get_app_version');
    if (v) label = 'v' + v;
  } catch {}
  ['current-version-display', 'topbar-version-display', 'about-version-display'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.textContent = label;
  });
}

async function init() {
  const bridgeReady = await ensureTauriBridge();
  if (!bridgeReady) {
    console.error('[Init] Tauri bridge not ready');
    showCustomAlert('应用核心通道未就绪，按钮将无法响应。请从安装包版本启动，或重启应用后重试。', '启动异常', 'error');
  }

  // 启动时清理残留弹层状态，避免透明遮罩占用点击事件
  document.querySelectorAll('.modal-overlay.active').forEach(el => el.classList.remove('active'));
  _diag('cleared leftover active modal overlays');

  bindProxyButtonHandlers();
  bindWindowControlHandlers();

  // 恢复/初始化侧边栏接入平台顺序，并启用拖拽
  if (typeof initPlatformRailOrder === 'function') initPlatformRailOrder();

  try {

    const saved = localStorage.getItem('byok-theme');
    if (saved) applyTheme(saved);
  } catch {}
  if (typeof syncIdeRestartPromptSetting === 'function') syncIdeRestartPromptSetting();

  await loadAndFillConfig();

  // 加载保存的 target_ide 配置；静态预览环境没有 Tauri invoke，保持默认值即可。
  if (invoke) {
    try {
      const config = await invoke('load_config') || {};
      if (config.target_ide) {
        const select = document.getElementById('targetIde');
        if (select) select.value = config.target_ide;
        updateFlowIdeTarget(config.target_ide);
      }
    } catch (e) {
      console.error('Failed to load target_ide:', e);
    }
  }
  // 同步初始化自定义选择器状态
  syncCustomSelector();
  if (typeof updateProxyPlatformCopy === 'function') {
    const target = typeof getTargetIde === 'function' ? getTargetIde() : 'windsurf';
    updateProxyPlatformCopy(target);
    if ((target === 'windsurf' || target === 'devin') && typeof setPlatformRailActive === 'function') {
      setPlatformRailActive(target);
    }
  }
  if (typeof renderEvalCheckPicker === 'function') {
    renderEvalCheckPicker();
  }

  await loadProviders();
  if (typeof loadProxyRoutes === 'function') {
    await loadProxyRoutes();
  }
  if (typeof refreshPlatforms === 'function') {
    await refreshPlatforms({ silent: true });
  }
  await loadEvalReports();
  await refreshStatus();

  // 自动启动代理（AUTO_START_PROXY 默认为 true）
  if (invoke) {
    try {
      const cfg = await invoke('load_config') || {};
      if (cfg.AUTO_START_PROXY !== 'false') {
        const s = await invoke('get_proxy_status');
        if (!s.running) {
          addLog('info', '正在自动启动代理…');
          await invoke('start_proxy_service');
          await refreshStatus();
          addLog('ok', '代理已自动启动');
        }
      }
    } catch (e) {
      addLog('warn', '自动启动代理失败: ' + e);
    }
  }

  // 加载自动更新设置并更新 UI 开关状态
  await loadUpdateSettings();
  // 显示当前版本号
  await syncAppVersionDisplay();

  bindUpdateJumpModalHandlers();
  // 检查是否刚进行了版本更新
  const hasJumpModal = await checkVersionJump();
  // 启动时自动检查更新（如果正在展示升级成功弹窗则延后，避免弹窗层级冲突）
  if (!hasJumpModal) {
    await autoCheckUpdate();
  }


  if (tauriEvent?.listen) {
    await tauriEvent.listen('proxy-log', (e) => {
      const p = e.payload || {};
      addLog(p.level || 'info', p.msg || '');
    });
    await tauriEvent.listen('proxy-stopped', () => {
      setStatusPill(false);
      addLog('warn', '代理进程已退出');
    });
    if (typeof bindEvalProgressListener === 'function') {
      await bindEvalProgressListener();
    }
    if (typeof bindSwitchProgressListener === 'function') {
      await bindSwitchProgressListener();
    }
  }

  setInterval(refreshStatus, 3000);
  setInterval(refreshStats, 3000);
  await refreshStats();
  addLog('info', 'AnyBridge 就绪');
}

init().catch(e => console.error('init failed:', e));
