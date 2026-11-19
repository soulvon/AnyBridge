// platforms/cursor_actions.js — Cursor 控制台启停、同步、重启与证书操作
// 主按钮动作：智能分流
async function cursorPrimaryAction() {
  if (cursorConsoleBusy) return;
  cursorEnsureBridge();

  const status = globalThis._cursorCachedStatus;
  if (!status?.certificateReady) {
    await cursorInstallCertAction();
    return;
  }
  if (globalThis._cursorModelsList.length === 0) {
    openCursorAddPage();
    return;
  }
  if (status?.running) {
    await cursorRefreshConsole();
    if (typeof addLog === 'function') addLog('info', 'Cursor 已处于接入状态');
    return;
  }

  await cursorEnableAction();
}

// 启动 Cursor 接入
async function cursorEnableAction() {
  if (cursorConsoleBusy) return;
  cursorSetBusy(true, '正在接入...');
  try {
    cursorEnsureBridge();
    if (typeof addLog === 'function') addLog('info', '正在启动 Cursor Core 协议网关并配置接入...');

    // 执行启用
    const result = await invoke('cursor_enable');
    globalThis._cursorCachedStatus = result;

    if (typeof addLog === 'function') addLog('ok', `Cursor Core 网关已在端口 ${result.controlPort} 启动，已写入代理设置`);
    await cursorRefreshConsole({ silent: true });

    if (typeof promptRestartIde === 'function') {
      await promptRestartIde('接入服务已启动，重启后生效。', 'cursor', {
        mode: 'proxy',
        statusText: null,
        detail: '重启后在右下角模型列表选择自备模型。'
      });
    } else {
      showCustomAlert(
        'Cursor Core 接入服务已启动并成功配置！\n\n请重启 Cursor IDE，在右下角模型列表中选择自备模型即可畅享 Agent。',
        '接入成功',
        'success'
      );
    }
  } catch (e) {
    console.error('[cursor] enable failed:', e);
    if (typeof addLog === 'function') addLog('err', 'Cursor 接入失败: ' + e);
    showCustomAlert(String(e), '启动接入失败', 'error');
  } finally {
    cursorSetBusy(false);
  }
}

// 还原直连 / 停用
async function cursorDisableAction() {
  if (cursorConsoleBusy) return;

  cursorSetBusy(true, '正在停止...');
  try {
    cursorEnsureBridge();
    if (typeof addLog === 'function') addLog('info', '正在停止 Cursor Core 并还原设置...');

    const result = await invoke('cursor_disable');
    globalThis._cursorCachedStatus = result;

    if (typeof addLog === 'function') addLog('ok', 'Cursor 已还原直连状态，Core 网关已安全退出');
    await cursorRefreshConsole({ silent: true });

    if (typeof promptRestartIde === 'function') {
      await promptRestartIde('已还原为直连配置，重启后生效。', 'cursor', {
        mode: 'direct',
        statusText: null
      });
    } else {
      showCustomAlert('Cursor 已成功还原直连配置。重启 Cursor 后配置即可生效。', '还原完成', 'success');
    }
  } catch (e) {
    console.error('[cursor] disable failed:', e);
    if (typeof addLog === 'function') addLog('err', 'Cursor 还原直连失败: ' + e);
    showCustomAlert(String(e), '还原失败', 'error');
  } finally {
    cursorSetBusy(false);
  }
}

// 实时热同步最新路由模型
async function cursorSyncRoutesAction() {
  if (cursorConsoleBusy) return;
  cursorSetBusy(true);
  try {
    cursorEnsureBridge();
    if (typeof addLog === 'function') addLog('info', '正在向 Cursor Core 同步最新模型路由...');

    const result = await invoke('cursor_sync_routes');
    globalThis._cursorCachedStatus = result;

    if (typeof addLog === 'function') addLog('ok', `模型路由热同步成功，当前可用模型数: ${result.configuredModels}`);
    await cursorRefreshConsole();
    showCustomAlert(`已将最新 ${result.configuredModels} 个内置模型推送到 Cursor！Cursor 下拉列表将自动生效。`, '同步成功', 'success');
  } catch (e) {
    console.error('[cursor] sync routes failed:', e);
    if (typeof addLog === 'function') addLog('err', '模型同步失败: ' + e);
    showCustomAlert(String(e), '同步失败', 'error');
  } finally {
    cursorSetBusy(false);
  }
}

// 重启 Core 服务
async function cursorRestartCoreAction() {
  if (cursorConsoleBusy) return;
  cursorSetBusy(true);
  try {
    cursorEnsureBridge();
    if (typeof addLog === 'function') addLog('info', '正在重启 Cursor Core 进程...');
    const result = await invoke('cursor_restart');
    globalThis._cursorCachedStatus = result;
    if (typeof addLog === 'function') addLog('ok', 'Cursor Core 已成功重启');
    await cursorRefreshConsole();
    showCustomAlert('Cursor Core 服务已成功重启并刷新配置。', '重启成功', 'success');
  } catch (e) {
    console.error('[cursor] restart core failed:', e);
    if (typeof addLog === 'function') addLog('err', '重启 Core 失败: ' + e);
    showCustomAlert(String(e), '重启失败', 'error');
  } finally {
    cursorSetBusy(false);
  }
}

// 重启 IDE 软件
async function cursorRestartIdeAction() {
  if (typeof restartIdeNow === 'function') {
    await restartIdeNow('cursor');
    return;
  }
  cursorEnsureBridge();
  try {
    const result = await invoke('restart_ide', { target: 'cursor' });
    if (typeof addLog === 'function') addLog('ok', result);
  } catch (e) {
    if (typeof addLog === 'function') addLog('err', 'Cursor 重启失败: ' + e);
    showCustomAlert(String(e), '重启失败', 'error');
  }
}

// 快速预检
async function cursorPreflightAction() {
  if (cursorConsoleBusy) return;
  cursorSetBusy(true);
  const tip = document.getElementById('cursor-diag-tip-text');
  if (tip) tip.textContent = '正在全面诊断 Cursor 接入环境（二进制、证书、网关 Key、模型路由）...';
  try {
    cursorEnsureBridge();
    const result = await invoke('cursor_preflight');
    globalThis._cursorCachedStatus = result;
    await cursorRefreshConsole();
    await syncCursorSettingsModalData();
    if (tip) {
      tip.innerHTML = '<span style="color:var(--success);font-weight:600;">✓ 环境预检全部通过：Core 二进制、CA 根证书、本地网关密钥与模型路由均已就绪。</span>';
    }
    showCustomAlert('Cursor Core 接入环境检查通过：\n\n✓ 二进制就绪\n✓ 本地网关 Key 已配置\n✓ AnyBridge 信任证书已就绪\n✓ 内置模型就绪', '预检通过', 'success');
  } catch (e) {
    if (tip) {
      const errStr = typeof escapeHtml === 'function' ? escapeHtml(String(e)) : String(e);
      tip.innerHTML = `<span style="color:var(--danger);font-weight:600;">✗ 预检未通过: ${errStr}</span>`;
    }
    await syncCursorSettingsModalData();
    showCustomAlert(String(e), '预检未通过', 'error');
  } finally {
    cursorSetBusy(false);
  }
}

// 安装/修复证书
async function cursorInstallCertAction() {
  if (cursorConsoleBusy) return;
  cursorSetBusy(true);
  try {
    cursorEnsureBridge();
    const result = await invoke('cert_install', { requestId: window.newCertRequestId() });
    if (typeof addLog === 'function') addLog('ok', 'CA 证书安装完成: ' + result);
    await cursorRefreshConsole();
    await syncCursorSettingsModalData();
    showCustomAlert(result || 'AnyBridge Local CA 根证书已安装并信任。', '证书已安装', 'success');
  } catch (e) {
    const errMsg = String(e);
    if (typeof addLog === 'function') addLog('err', 'CA 安装失败: ' + errMsg);
    if (errMsg.includes('请先停止网关') || errMsg.includes('请等待完成后再操作')) {
      showCustomAlert(
        errMsg + '\n\n请先停止网关，再到「平台 > 设置 > 环境检测」点击「一键安装证书」。',
        '需先停止网关',
        'warning'
      );
    } else {
      showCustomAlert(errMsg, '证书安装失败', 'error');
    }
  } finally {
    cursorSetBusy(false);
  }
}

function cursorOpenProxyModels() {
  if (typeof openProxyPanel === 'function') {
    openProxyPanel('routes');
  } else {
    navigateTo('proxy');
  }
}

function cursorOpenProxyLogs() {
  if (typeof openProxyPanel === 'function') {
    openProxyPanel('logs');
  } else {
    navigateTo('proxy');
  }
}

// 保持历史函数兼容性挂载
function cursorStartProxy() { return cursorEnableAction(); }
function cursorSwitchToProxy() { return cursorEnableAction(); }
function cursorRestoreDirect() { return cursorDisableAction(); }
function cursorRestartIde() { return cursorRestartIdeAction(); }
function cursorRunHealthcheck() { return cursorPreflightAction(); }
function cursorInstallCert() { return cursorInstallCertAction(); }
function cursorOpenStats() { return cursorOpenProxyLogs(); }

// ---- P3 globalThis mirror ----
(function mirrorFns(g) {
  g.cursorPrimaryAction = cursorPrimaryAction;
  g.cursorEnableAction = cursorEnableAction;
  g.cursorDisableAction = cursorDisableAction;
  g.cursorSyncRoutesAction = cursorSyncRoutesAction;
  g.cursorRestartCoreAction = cursorRestartCoreAction;
  g.cursorRestartIdeAction = cursorRestartIdeAction;
  g.cursorPreflightAction = cursorPreflightAction;
  g.cursorInstallCertAction = cursorInstallCertAction;
  g.cursorOpenProxyModels = cursorOpenProxyModels;
  g.cursorOpenProxyLogs = cursorOpenProxyLogs;
  g.cursorStartProxy = cursorStartProxy;
  g.cursorSwitchToProxy = cursorSwitchToProxy;
  g.cursorRestoreDirect = cursorRestoreDirect;
  g.cursorRestartIde = cursorRestartIde;
  g.cursorRunHealthcheck = cursorRunHealthcheck;
  g.cursorInstallCert = cursorInstallCert;
  g.cursorOpenStats = cursorOpenStats;
})(globalThis);
