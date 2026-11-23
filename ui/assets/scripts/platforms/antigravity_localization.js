// platforms/antigravity_localization.js — Antigravity 一键汉化、日志面板与 CDP 深度注入
function appendAntigravityLangLog(text, level = 'info') {
  const box = document.getElementById('antigravityLangLogBox');
  if (!box) return;
  const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  let prefix = '[信息]';
  if (level === 'ok') prefix = '[成功]';
  else if (level === 'warn') prefix = '[警告]';
  else if (level === 'err') prefix = '[错误]';
  const line = document.createElement('div');
  line.textContent = `[${time}] ${prefix} ${text}`;
  if (level === 'ok') line.style.color = 'var(--success)';
  else if (level === 'warn') line.style.color = 'var(--accent-warm)';
  else if (level === 'err') line.style.color = 'var(--danger)';
  box.appendChild(line);
  box.scrollTop = box.scrollHeight;
}

function clearAntigravityLangLog() {
  const box = document.getElementById('antigravityLangLogBox');
  if (box) box.textContent = '';
}

async function openAntigravityLangModal() {
  const modal = document.getElementById('antigravityLangModal');
  if (!modal) return;
  modal.classList.add('active');
  const target = getAntigravityTarget();
  const platName = target === 'antigravity-ide' ? 'Antigravity IDE' : 'Antigravity';
  const clientNameEl = document.getElementById('antigravityLangModalClientName');
  if (clientNameEl) clientNameEl.textContent = platName;
  clearAntigravityLangLog();
  appendAntigravityLangLog(`已打开 ${platName} 汉化管理面板，正在探测环境状态...`);
  void refreshAntigravityLangStatus(true);
  // 设置页/Agent 面板是内嵌网页，需要单独的运行期注入状态（仅 IDE 显示）
  void refreshAntigravityCdpStatus();
}

function closeAntigravityLangModal() {
  const modal = document.getElementById('antigravityLangModal');
  if (modal) modal.classList.remove('active');
}

async function refreshAntigravityLangStatus(updateModal = false) {
  if (!updateModal) {
    if (typeof syncAntigravityEnhanceEntryButton === 'function') {
      return syncAntigravityEnhanceEntryButton();
    }
    return;
  }
  if (typeof invoke !== 'function') return;
  const target = getAntigravityTarget();
  const platName = target === 'antigravity-ide' ? 'Antigravity IDE' : 'Antigravity';
  const isIde = target === 'antigravity-ide';

  try {
    const status = target === 'antigravity-ide'
      ? await invoke('get_app_localization_status', { platform: 'antigravity-ide' })
      : await invoke('get_antigravity_localization_status', { target });
    if (typeof syncAntigravityEnhanceEntryButton === 'function') {
      void syncAntigravityEnhanceEntryButton();
    }

    if (updateModal) {
      const badge = document.getElementById('antigravityLangModalStatusBadge');
      const verEl = document.getElementById('antigravityLangModalVer');
      const restoreBtn = document.getElementById('antigravityLangModalRestoreBtn');
      const applyBtn = document.getElementById('antigravityLangModalApplyBtn');

      if (badge) {
        // 与其它平台统一：已汉化=绿，未汉化=中性灰（未汉化是正常状态，不用警告色）
        if (status?.localized) {
          badge.textContent = '已汉化';
          badge.style.background = 'rgba(16, 185, 129, 0.15)';
          badge.style.color = '#10b981';
        } else {
          badge.textContent = '未汉化';
          badge.style.background = 'var(--bg-glass-elevated, rgba(255,255,255,0.06))';
          badge.style.color = 'var(--text-muted)';
        }
      }
      if (verEl && status?.currentVersion) {
        verEl.textContent = 'v' + status.currentVersion;
      }
      // 第 4 行与其它平台对齐：IDE 走 app_localization（有语言包状态），
      // Hub 是 asar 注入不需要语言包，显示同理状态而非空白。
      const langPackEl = document.getElementById('antigravityLangModalLangPack');
      if (langPackEl) {
        if (isIde) {
          const ok = !!status?.langPackInstalled;
          langPackEl.textContent = ok ? '已安装' : '未安装';
          langPackEl.style.color = ok ? '#10b981' : 'var(--text-muted)';
        } else {
          langPackEl.textContent = '无需安装（内置词库）';
          langPackEl.style.color = 'var(--text-muted)';
        }
      }
      if (restoreBtn) {
        restoreBtn.disabled = !status?.localized;
      }
      if (applyBtn) {
        applyBtn.textContent = status?.localized ? '重新应用汉化' : '一键应用汉化';
      }

      if (status?.installed) {
        appendAntigravityLangLog(`检测到 ${platName} 已安装，当前状态: ${status.localized ? '已汉化' : '官方英文未汉化'}`);
      } else {
        appendAntigravityLangLog(`未检测到 ${platName} 的标准安装目录，请先安装该客户端`, 'warn');
      }
    }
  } catch (err) {
    if (updateModal) appendAntigravityLangLog(`状态探测异常: ${err}`, 'err');
  }
}

// 汉化专用重启确认：复用与「一键接入」同一套精致重启弹窗，仅文案按汉化语义定制
async function confirmRestartAntigravityClient(actionDesc, targetOverride = null) {
  const target = targetOverride || getAntigravityTarget();
  const platName = target === 'antigravity-ide' ? 'Antigravity IDE' : 'Antigravity';
  if (typeof promptRestartIde !== 'function') return false;

  // lead 不带客户端名：标题（"重启 {客户端}"）已含，重复显得冗余（各平台统一）。
  const restarted = await promptRestartIde(
    `${actionDesc}，是否立即重启客户端使其生效？`,
    target,
    {
      title: `重启 ${platName}`,
      // 要点已并入上方问句，隐藏重复的状态条；「重启会强制关闭 IDE」的警示保留
      statusText: null,
      skipAutoPreference: true
    }
  );

  if (restarted) {
    const restartedMsg = typeof t === 'function' ? t('agLoc.restartedApplied') : 'restarted, changes applied';
    appendAntigravityLangLog(`${platName} ${restartedMsg}`, 'ok');
    // 重启成功后关掉汉化面板
    document.getElementById('antigravityLangModal')?.classList.remove('active');
  } else {
    appendAntigravityLangLog(`已选择稍后重启，下次启动客户端后生效`);
  }
  return restarted;
}

async function applyAntigravityLocalizationAction() {
  const target = getAntigravityTarget();
  const platName = target === 'antigravity-ide' ? 'Antigravity IDE' : 'Antigravity';
  const isIde = target === 'antigravity-ide';

  appendAntigravityLangLog(`----------------------------------------`);
  setPlatformBusy(target, true);
  try {
    // 词库策略（对齐反馈）：apply 不做更新检查，本地有词库直接用（内置基线已包含完整词典）。
    appendAntigravityLangLog(`[1/4] 正在准备中文词库...`);
    try {
      const st = isIde
        ? await invoke('get_app_localization_status', { platform: 'antigravity-ide' })
        : null;
      appendAntigravityLangLog(`词库已就绪 (v${st?.currentVersion || 'baseline'})`);
    } catch (e) {
      appendAntigravityLangLog(`状态读取失败，将直接使用内置词库: ${e}`, 'warn');
    }
    // 第二步：应用汉化
    appendAntigravityLangLog(`[2/4] 正在检测 ${platName} 安装与写入权限...`);
    appendAntigravityLangLog(`[3/4] 正在备份原版资源并写入汉化...`);
    const res = isIde
      ? await invoke('apply_app_localization', { platform: 'antigravity-ide' })
      : await invoke('apply_antigravity_localization', { target });
    appendAntigravityLangLog(`[4/4] ${res?.message || '汉化注入完成！'}`, 'ok');
    await refreshAntigravityLangStatus(true);
    if (typeof showBottomToast === 'function') {
      showBottomToast(res?.message || `${platName} 汉化成功`, 'success');
    }
    const restarted = await confirmRestartAntigravityClient('汉化补丁已成功注入');
    if (isIde && restarted) {
      void (async () => {
        for (let i = 0; i < 8; i += 1) {
          await new Promise((r) => setTimeout(r, 1500));
          const cdpSt = await invoke('get_antigravity_cdp_status').catch(() => null);
          if (cdpSt?.available) {
            const res2 = await invoke('apply_antigravity_cdp_localization').catch(() => null);
            if (res2) renderAntigravityCdpState(res2);
            break;
          }
        }
      })();
    }
  } catch (e) {
    appendAntigravityLangLog(`汉化失败: ${e?.message || e}`, 'err');
    showCustomAlert(String(e?.message || e), '汉化失败', 'error');
  } finally {
    setPlatformBusy(target, false);
  }
}

async function restoreAntigravityLocalizationAction() {
  const target = getAntigravityTarget();
  const platName = target === 'antigravity-ide' ? 'Antigravity IDE' : 'Antigravity';
  const isIde = target === 'antigravity-ide';

  appendAntigravityLangLog(`----------------------------------------`);
  appendAntigravityLangLog(`[1/2] 正在检索 ${platName} 官方原版备份并准备还原...`);
  setPlatformBusy(target, true);
  try {
    const res = isIde
      ? await invoke('restore_app_localization', { platform: 'antigravity-ide' })
      : await invoke('restore_antigravity_localization', { target });
    appendAntigravityLangLog(`[2/2] ${res?.message || '已成功还原官方英文原版！'}`, 'ok');
    await refreshAntigravityLangStatus(true);
    if (typeof showBottomToast === 'function') {
      showBottomToast(res?.message || `${platName} 已恢复英文原版`, 'success');
    }
    await confirmRestartAntigravityClient('已还原官方英文原版');
  } catch (e) {
    appendAntigravityLangLog(`还原英文失败: ${e?.message || e}`, 'err');
    showCustomAlert(String(e?.message || e), '还原失败', 'error');
  } finally {
    setPlatformBusy(target, false);
  }
}

async function checkAntigravityLocalizationUpdateAction() {
  const target = getAntigravityTarget();
  const isIde = target === 'antigravity-ide';
  appendAntigravityLangLog(`----------------------------------------`);
  appendAntigravityLangLog(`正在检查上游词库更新...`);
  try {
    const info = isIde
      ? await invoke('check_app_localization_update', { platform: 'antigravity-ide' })
      : await invoke('check_antigravity_localization_update');
    appendAntigravityLangLog(`上游词库版本: ${info?.latestVersion || '未知'}`);
    if (info?.hasUpdate) {
      appendAntigravityLangLog(`发现新版词库（当前 v${info.currentVersion}），正在下载...`, 'ok');
      const dl = isIde
        ? await invoke('download_app_localization_update', { platform: 'antigravity-ide' })
        : await invoke('download_antigravity_localization_update');
      appendAntigravityLangLog(`词库下载成功: ${dl?.message}`, 'ok');
      // 只下载，不自动应用：是否注入、何时注入由用户决定（应用按钮才是注入入口）
      appendAntigravityLangLog(`新词库已就绪，点击「重新应用汉化」即可生效`, 'warn');
      if (typeof showBottomToast === 'function') {
        showBottomToast('词库已更新，点击「重新应用汉化」生效', 'success');
      }
    } else {
      appendAntigravityLangLog(`当前词库已是最新版本 (v${info?.currentVersion || 'baseline'})，无需更新`, 'ok');
      if (typeof showBottomToast === 'function') {
        showBottomToast(`当前汉化词库已是最新版本 (v${info?.currentVersion || 'baseline'})`, 'success');
      }
    }
  } catch (e) {
    appendAntigravityLangLog(`检查在线更新失败（不影响离线使用内置汉化）: ${e}`, 'warn');
    showCustomAlert('检查在线更新失败（将使用内置离线汉化词库）：\n' + String(e?.message || e), '检查提示', 'info');
  }
}

// ═══════ Antigravity 深度汉化（设置页 / Agent 面板，CDP 运行期注入）═══════
// 这两块界面由客户端内嵌的本地网页渲染（扩展 iframe + 编译进 agy.exe 的资源），
// 文件注入够不到；只能以 --remote-debugging-port 启动 IDE，再由后端 CDP 注入词库。

function renderAntigravityCdpState(st) {
  const badge = document.getElementById('antigravityLangCdpBadge');
  const hint = document.getElementById('antigravityLangCdpHint');
  const btn = document.getElementById('antigravityLangCdpBtn');
  if (!badge || !hint || !btn) return;
  if (st?.available) {
    const allDone = st.targets > 0 && st.injected >= st.targets;
    badge.textContent = allDone ? '已注入' : (st.targets > 0 ? '待注入' : '已就绪');
    badge.style.background = allDone ? 'rgba(16, 185, 129, 0.15)' : 'rgba(37, 99, 235, 0.12)';
    badge.style.color = allDone ? '#10b981' : 'var(--accent)';
    hint.textContent = st.message
      || `已识别 ${st.injected}/${st.targets} 个界面，页面刷新后会自动补注入。`;
    btn.textContent = '立即注入当前界面';
    return;
  }
  badge.textContent = '未启用';
  badge.style.background = 'var(--bg-glass-elevated, rgba(255,255,255,0.06))';
  badge.style.color = 'var(--text-muted)';
  hint.textContent = st?.message
    || '需要以汉化模式（带调试端口）启动 IDE，才能翻译这两块界面。';
  btn.textContent = '以汉化模式重启 IDE';
}

async function refreshAntigravityCdpStatus() {
  const block = document.getElementById('antigravityLangCdpBlock');
  if (!block) return;
  const isIde = getAntigravityTarget() === 'antigravity-ide';
  block.style.display = isIde ? '' : 'none';
  if (!isIde || typeof invoke !== 'function') return;
  try {
    const st = await invoke('get_antigravity_cdp_status');
    renderAntigravityCdpState(st);
  } catch (e) {
    const hint = document.getElementById('antigravityLangCdpHint');
    if (hint) hint.textContent = `状态检测失败：${e?.message || e}`;
  }
}

async function handleAntigravityCdpAction() {
  if (getAntigravityTarget() !== 'antigravity-ide') return;
  if (typeof invoke !== 'function') return;
  const btn = document.getElementById('antigravityLangCdpBtn');
  setLoading(btn, '检测中…');
  try {
    const st = await invoke('get_antigravity_cdp_status');
    if (st?.available) {
      setLoading(btn, '注入中…');
      const res = await invoke('apply_antigravity_cdp_localization');
      clearLoading(btn);
      renderAntigravityCdpState(res);
      appendAntigravityLangLog(res?.message || '已完成运行期注入', 'ok');
      return;
    }

    clearLoading(btn);
    const ok = await showCustomConfirm(
      '需要先关闭 Antigravity IDE，再以汉化模式重新打开，未保存的编辑会丢失。继续吗？',
      '以汉化模式重启 Antigravity IDE',
      'warn'
    );
    if (!ok) return;

    setLoading(btn, '重启中…');
    appendAntigravityLangLog('正在关闭 IDE 并以汉化模式启动…');
    const msg = await invoke('restart_antigravity_ide_with_cdp');
    appendAntigravityLangLog(msg || '已完成重启', 'ok');

    // 等调试端口就绪（最多 30 秒）。超时如实提示，不假装成功。
    let ready = false;
    for (let i = 0; i < 15; i += 1) {
      await new Promise((r) => setTimeout(r, 2000));
      const s2 = await invoke('get_antigravity_cdp_status').catch(() => null);
      if (s2?.available) {
        ready = true;
        break;
      }
    }
    if (!ready) {
      clearLoading(btn);
      renderAntigravityCdpState(null);
      appendAntigravityLangLog('调试端口未在 30 秒内就绪，请等 IDE 打开后点一次「立即注入」', 'warn');
      return;
    }
    const res2 = await invoke('apply_antigravity_cdp_localization');
    clearLoading(btn);
    renderAntigravityCdpState(res2);
    appendAntigravityLangLog(res2?.message || '已完成运行期注入，打开设置页即为中文', 'ok');
  } catch (e) {
    clearLoading(btn);
    appendAntigravityLangLog(`深度汉化失败: ${e?.message || e}`, 'err');
    showCustomAlert(String(e?.message || e), '深度汉化失败', 'error');
  } finally {
    clearLoading(btn);
  }
}

// ---- P3 globalThis mirror ----
(function mirrorFns(g) {
  g.appendAntigravityLangLog = appendAntigravityLangLog;
  g.clearAntigravityLangLog = clearAntigravityLangLog;
  g.openAntigravityLangModal = openAntigravityLangModal;
  g.closeAntigravityLangModal = closeAntigravityLangModal;
  g.refreshAntigravityLangStatus = refreshAntigravityLangStatus;
  g.confirmRestartAntigravityClient = confirmRestartAntigravityClient;
  g.applyAntigravityLocalizationAction = applyAntigravityLocalizationAction;
  g.restoreAntigravityLocalizationAction = restoreAntigravityLocalizationAction;
  g.checkAntigravityLocalizationUpdateAction = checkAntigravityLocalizationUpdateAction;
  g.renderAntigravityCdpState = renderAntigravityCdpState;
  g.refreshAntigravityCdpStatus = refreshAntigravityCdpStatus;
  g.handleAntigravityCdpAction = handleAntigravityCdpAction;
})(globalThis);
