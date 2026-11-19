// plugins/lifecycle.js — 插件启停、健康检查、升级检查与卸载操作
import { pluginRuntime, pluginTokenCache, PLUGIN_STATE_META, pluginInvoke, pluginNotify, pluginLog, getPlugin, getPluginConfig, getPluginToken, pluginStateMeta, getPluginActionConfig } from './shared.js';

async function startPlugin(pluginId) {
  pluginLog('info', `正在启动插件【${pluginId}】...`);
  try {
    pluginNotify(`正在启动 ${pluginId}...`, 'info');
    await pluginInvoke('plugin_start', { pluginId });
    pluginLog('ok', `插件【${pluginId}】启动成功，健康检查通过。`);
    await refreshPluginList();
  } catch (e) {
    pluginNotify(`启动失败: ${e}`, 'error');
    pluginLog('err', `插件【${pluginId}】启动失败: ${e}`);
    await refreshPluginList();
  }
}

async function stopPlugin(pluginId) {
  pluginLog('warn', `正在停止插件【${pluginId}】...`);
  try {
    await pluginInvoke('plugin_stop', { pluginId });
    pluginTokenCache.delete(pluginId);
    pluginLog('ok', `插件【${pluginId}】已成功停止。`);
    pluginNotify(`${pluginId} 已停止`, 'ok');
    await refreshPluginList();
  } catch (e) {
    pluginNotify(`停止失败: ${e}`, 'error');
    pluginLog('err', `插件【${pluginId}】停止失败: ${e}`);
  }
}

async function restartPlugin(pluginId) {
  pluginLog('warn', `正在重启插件【${pluginId}】...`);
  try {
    pluginNotify(`正在重启 ${pluginId}...`, 'info');
    await pluginInvoke('plugin_restart', { pluginId });
    pluginTokenCache.delete(pluginId);
    pluginLog('ok', `插件【${pluginId}】重启成功，健康检查通过。`);
    await refreshPluginList();
  } catch (e) {
    pluginNotify(`重启失败: ${e}`, 'error');
    pluginLog('err', `插件【${pluginId}】重启失败: ${e}`);
  }
}

function setPluginTransientState(pluginId, state, label) {
  const plugin = getPlugin(pluginId);
  if (plugin) {
    plugin.status = { ...(plugin.status || {}), state, error: null };
  }
}

async function checkPluginUpdate(pluginId, opts = {}) {
  const options = typeof opts === 'boolean' ? { autoUpdate: opts } : (opts || {});
  const silent = Boolean(options.silent);
  const autoUpdate = Boolean(options.autoUpdate);

  const plugin = getPlugin(pluginId);
  const pluginName = plugin?.manifest?.name || pluginId;

  if (globalThis.pluginUpdateChecking?.has(pluginId)) return;
  globalThis.pluginUpdateChecking?.add(pluginId);

  if (!silent) {
    pluginLog('info', `正在检查【${pluginName}】的 GitHub 最新发布包...`);
  }

  const updateBtns = document.querySelectorAll(`[data-action="checkPluginUpdate"][data-arg="${pluginId}"]`);
  updateBtns.forEach(b => { b.disabled = true; b.innerHTML = loadingHtml('检测中…'); });

  try {
    const report = await pluginInvoke('plugin_check_update', { pluginId });
    globalThis.pluginUpdateReports.set(pluginId, report || null);
    const hasUpdate = Boolean(report?.hasUpdate);

    renderPluginList();

    if (hasUpdate || !silent) {
      pluginLog(hasUpdate ? 'warn' : 'ok', `【${pluginName}】更新检测完成: ${report?.message || (hasUpdate ? '发现新版本' : '已是最新版本')}`);
    }

    if (autoUpdate && hasUpdate) {
      await upgradePlugin(pluginId, { skipConfirm: true });
      return;
    }

    if (!silent) {
      if (!hasUpdate) {
        if (typeof showCustomAlert === 'function') {
          const body = `${pluginName}：${report?.currentVersion || plugin?.manifest?.version || 'v1.2.6'}（已是最新）\n\n检测时间: ${new Date().toLocaleString('zh-CN', { hour12: false })}`;
          showCustomAlert(body, `${pluginName} 更新检测`, 'success');
        } else {
          pluginNotify(`【${pluginName}】已是最新版本`, 'ok');
        }
        return;
      }

      if (typeof showCustomConfirm === 'function') {
        const body = `${pluginName}：当前 ${report.currentVersion || plugin?.manifest?.version || 'v1.2.6'} 更新为 ${report.latestVersion || '最新'}\n\n将停止服务、拉取最新代码并重新编译（服务会短暂中断）。是否立即更新？`;
        const confirmed = await showCustomConfirm(body, `${pluginName} 有新版本`, 'warn');
        if (confirmed) {
          await upgradePlugin(pluginId, { skipConfirm: true });
        }
        return;
      }

      if (typeof showCustomAlert === 'function') {
        const body = `${pluginName}：发现新版本 ${report?.latestVersion}\n\n检测时间: ${new Date().toLocaleString('zh-CN', { hour12: false })}`;
        showCustomAlert(body, `${pluginName} 更新检测`, 'warn');
      }
    }
  } catch (e) {
    const message = String(e?.message || e);
    if (!silent) {
      pluginLog('err', `【${pluginName}】更新检测失败: ${message}`);
      if (typeof showCustomAlert === 'function') {
        showCustomAlert(message, `${pluginName} 更新检测失败`, 'error');
      } else {
        pluginNotify(`检测更新失败: ${message}`, 'error');
      }
    }
  } finally {
    globalThis.pluginUpdateChecking?.delete(pluginId);
    updateBtns.forEach(b => { b.disabled = false; b.textContent = '检测更新'; });
    renderPluginList();
  }
}

async function upgradePlugin(pluginId, opts = {}) {
  const options = typeof opts === 'boolean' ? { skipConfirm: opts } : (opts || {});
  const skipConfirm = Boolean(options.skipConfirm);

  const plugin = getPlugin(pluginId);
  const pluginName = plugin?.manifest?.name || pluginId;

  if (!skipConfirm) {
    const confirmed = typeof showCustomConfirm === 'function'
      ? await showCustomConfirm(
          '检测到新版本，将停止服务、拉取最新代码并重新编译，服务会短暂中断。确定更新？',
          `确认更新 ${pluginName}`,
          'warn'
        )
      : true;
    if (!confirmed) return;
  }

  setPluginTransientState(pluginId, 'updating', '开始更新...');
  pluginLog('warn', `开始更新【${pluginName}】...`);
  renderPluginList();

  try {
    await pluginInvoke('plugin_upgrade', { pluginId });
    globalThis.pluginUpdateReports.delete(pluginId);
    pluginLog('ok', `【${pluginName}】更新完成！`);
    if (typeof showBottomToast === 'function') {
      showBottomToast(`${pluginName} 更新完成！`, 'success');
    } else {
      pluginNotify(`${pluginName} 更新完成！`, 'ok');
    }
    await refreshPluginList();
  } catch (e) {
    const message = String(e?.message || e);
    pluginLog('err', `【${pluginName}】更新失败: ${message}`);
    if (typeof showCustomAlert === 'function') {
      showCustomAlert(message, `${pluginName} 更新失败`, 'error');
    } else {
      pluginNotify(`更新失败: ${message}`, 'error');
    }
    await refreshPluginList();
  }
}

async function uninstallPlugin(pluginId) {
  const plugin = getPlugin(pluginId);
  const pluginName = plugin?.manifest?.name || pluginId;
  const ok = typeof showCustomConfirm === 'function'
    ? await showCustomConfirm(`确定卸载【${pluginName}】？安装目录与本地数据将被删除，无法恢复。`, '卸载插件', 'warn')
    : window.confirm(`确定卸载【${pluginName}】？`);
  if (!ok) return;

  pluginLog('warn', `正在卸载插件【${pluginName}】...`);

  // 1. 设置卸载中过渡态并重新渲染呈现进度条
  setPluginTransientState(pluginId, 'uninstalling', '卸载中...');
  renderPluginList();

  try {
    await pluginInvoke('plugin_uninstall', { pluginId });
    pluginTokenCache.delete(pluginId);
    pluginLog('ok', `插件【${pluginName}】已成功卸载，本地文件与配置已清理。`);
    pluginNotify(`【${pluginName}】已成功卸载`, 'ok');
    closePluginManager();
    await refreshPluginList();
  } catch (e) {
    pluginNotify(`卸载失败: ${e}`, 'error');
    pluginLog('err', `插件【${pluginName}】卸载失败: ${e}`);
    await refreshPluginList();
  }
}

async function openPluginConsole(pluginId) {
  const config = await getPluginConfig(pluginId);
  const port = Number(config?.port) || 5566;
  const url = `http://127.0.0.1:${port}`;
  await openPluginLink(url);
}

async function copyPluginText(text, label = '地址') {
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    pluginNotify(`已复制${label}`, 'ok');
  } catch {
    pluginNotify('复制失败', 'error');
  }
}

async function checkPluginHealth(pluginId) {
  try {
    const result = await pluginInvoke('plugin_health_check', { pluginId });
    const el = document.getElementById('plugin-health-line');
    if (el) {
      el.textContent = result?.ok
        ? `健康 · 延迟 ${result.latency ?? '-'}ms`
        : `不健康 · ${result?.detail || result?.status || '无响应'}`;
      el.className = `plugin-health-line ${result?.ok ? 'is-ok' : 'is-bad'}`;
    }
    return result;
  } catch (e) {
    pluginNotify(`健康检查失败: ${e}`, 'error');
    return null;
  }
}

// ═══════════════════════════════════════════════════
// PluginDeployDialog
// ═══════════════════════════════════════════════════

// ---- P3 globalThis mirror ----
(function mirrorFns(g) {
  g.startPlugin = startPlugin;
  g.stopPlugin = stopPlugin;
  g.restartPlugin = restartPlugin;
  g.setPluginTransientState = setPluginTransientState;
  g.checkPluginUpdate = checkPluginUpdate;
  g.upgradePlugin = upgradePlugin;
  g.uninstallPlugin = uninstallPlugin;
  g.openPluginConsole = openPluginConsole;
  g.copyPluginText = copyPluginText;
  g.checkPluginHealth = checkPluginHealth;
})(globalThis);
