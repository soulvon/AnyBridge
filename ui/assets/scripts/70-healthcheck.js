// ES module (P3) — vars on globalThis; functions kept + mirrored for hoist + data-action.
// 70-healthcheck.js — 「环境体检」独立 tab 的渲染逻辑
//
// 数据流：
//   用户点「一键体检」 → invoke('healthcheck_grouped', { targetIde })
//     → 后端按 8 大类分好组返回 → renderGroupedReport() 渲染卡片
//     → 用户点「导出/复制」生成 Markdown 报告
//
// 报告 Markdown 格式稳定（用户可保存到本地发给开发者诊断问题）

(function () {
  let _lastReport = null;
  let _certInstallProgressUnlisten = null;
  let _lastCertProgressMessage = '';

  // ── 上下文感知的元素查找 ──
  // 当用户在「平台 → 设置 → 环境检测」面板操作时，getElementById 会找到
  // 设置页面原始的那个元素而非克隆的。此函数优先从当前活跃的 mount 容器查找。
  function _hEl(id) {
    if (typeof _platformEl === 'function') return _platformEl(id);
    return document.getElementById(id);
  }

  // ──────────────────────────────────────────────
  // 入口：用户点「一键体检」按钮
  // ──────────────────────────────────────────────
  window.runHealthcheck = async function () {
    if (!invoke) {
      try { if (typeof bindTauriBridge === 'function') bindTauriBridge(); } catch (_) {}
      if (!invoke) { addLog && addLog('err', 'Tauri 通道未就绪'); return; }
    }
    const target = (typeof getTargetIde === 'function' ? getTargetIde() : 'devin');

    const runBtn = _hEl('health-run-btn');
    if (runBtn) {
      runBtn.disabled = true;
      const ic = runBtn.querySelector('.health-btn-icon');
      if (ic) ic.textContent = '⏳';
    }

    setHealthSummary('正在诊断环境各项指标（证书、路径、配置、端口、连通性）...', 'pending');
    enableExportButtons(false);
    const groupsContainer = _hEl('health-groups');
    if (groupsContainer) {
      groupsContainer.innerHTML = renderHealthSkeleton();
    }
    addLog && addLog('ok', '环境检测: 正在执行（首次可能需要 1-2 秒）...');

    try {
      const report = await invoke('healthcheck_grouped', { targetIde: target });
      _lastReport = report;
      renderGroupedReport(report);
      enableExportButtons(true);
      addLog && addLog('ok', `环境检测: 完成 (${report.totals.err} 错误 / ${report.totals.warn} 警告 / ${report.totals.ok} 通过)`);
    } catch (e) {
      setHealthSummary('检测失败: ' + escapeHtml(String(e)), 'err');
      addLog && addLog('err', '环境检测执行失败: ' + e);
    } finally {
      if (runBtn) {
        runBtn.disabled = false;
        const ic = runBtn.querySelector('.health-btn-icon');
        if (ic) ic.textContent = '▶';
      }
    }
  };

  // ──────────────────────────────────────────────
  // 入口：用户点「生成证书」按钮
  // generate_certs 会写入 certs/server.codeium.com.pem 和 key，并尝试顺手安装 CA。
  // ──────────────────────────────────────────────
  window.generateCertsFromHealth = async function () {
    if (!invoke) {
      try { if (typeof bindTauriBridge === 'function') bindTauriBridge(); } catch (_) {}
      if (!invoke) {
        setCertInstallProgress({ message: 'Tauri 通道未就绪，无法生成证书', percent: 100, level: 'err' });
        addLog && addLog('err', '证书生成失败: Tauri 通道未就绪');
        return;
      }
    }
    const btn = _hEl('health-generate-cert-btn');
    if (btn) {
      btn.disabled = true;
      btn.dataset.oldText = btn.textContent;
      btn.textContent = '生成中...';
    }
    setCertInstallProgress({ message: '正在生成 MITM 证书', percent: 10, level: 'info' });
    addLog && addLog('ok', '正在生成 MITM 证书...');
    try {
      const msg = await invoke('generate_certs');
      setCertInstallProgress({ message: msg || '证书已生成', percent: 100, level: 'ok' });
      addLog && addLog('ok', '证书生成: ' + msg);
      await window.runHealthcheck();
    } catch (e) {
      const errMsg = String(e);
      setCertInstallProgress({ message: '生成失败: ' + errMsg, percent: 100, level: 'err' });
      addLog && addLog('err', '证书生成失败: ' + errMsg);
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = btn.dataset.oldText || '生成证书';
      }
    }
  };

  // ──────────────────────────────────────────────
  // 入口：用户点「一键安装证书」按钮
  // 后端 install_ca 已经做了"CurrentUser 优先，UAC 兜底"的两阶段逻辑
  // ──────────────────────────────────────────────
  window.installCaFromHealth = async function () {
    if (!invoke) {
      try { if (typeof bindTauriBridge === 'function') bindTauriBridge(); } catch (_) {}
      if (!invoke) {
        setCertInstallProgress({ message: 'Tauri 通道未就绪，无法安装证书', percent: 100, level: 'err' });
        addLog && addLog('err', 'CA 证书安装失败: Tauri 通道未就绪');
        return;
      }
    }
    await ensureCertInstallProgressListener();
    _lastCertProgressMessage = '';
    setCertInstallProgress({ message: '准备安装 CA 证书', percent: 3, level: 'info' });
    addLog && addLog('ok', '正在安装 CA 证书到系统根证书库...');
    setInstallCertButtonState('busy');
    try {
      const msg = await invoke('cert_install');
      setCertInstallProgress({ message: msg || 'CA 证书安装完成', percent: 100, level: 'ok' });
      addLog && addLog('ok', 'CA 证书安装: ' + msg);
      await window.runHealthcheck();
    } catch (e) {
      const errMsg = String(e);
      setCertInstallProgress({ message: '安装失败: ' + errMsg, percent: 100, level: 'err' });
      addLog && addLog('err', 'CA 证书安装失败: ' + errMsg);
      if (errMsg.includes('取消') || errMsg.includes('拒绝')) {
        showCustomAlert && showCustomAlert(
          '你取消了 UAC 授权（或拒绝访问）。CA 证书未安装到系统根证书库，IDE 会继续拒绝连接。\n\n如需重试，请再次点击「一键安装证书」。',
          'CA 安装被取消',
          'warning'
        );
      }
    } finally {
      setInstallCertButtonState('idle');
    }
  };

  // ──────────────────────────────────────────────
  // 入口：用户点「清理并重装」—— 删旧 PEM + 卸旧 CN/旧指纹 + 重生 + 装信任库
  // 给别人机器上证书乱/不匹配时一键修复用。
  // ──────────────────────────────────────────────
  window.reinstallCaFromHealth = async function () {
    if (!invoke) {
      try { if (typeof bindTauriBridge === 'function') bindTauriBridge(); } catch (_) {}
      if (!invoke) {
        setCertInstallProgress({ message: 'Tauri 通道未就绪，无法清理并重装证书', percent: 100, level: 'err' });
        addLog && addLog('err', 'CA 清理并重装失败: Tauri 通道未就绪');
        return;
      }
    }
    await ensureCertInstallProgressListener();
    _lastCertProgressMessage = '';
    setCertInstallProgress({ message: '准备清理旧证书并重新安装', percent: 3, level: 'warn' });
    addLog && addLog('warn', '正在清理并重装 CA 证书（强制重生 + 重装信任库）...');
    const btn = _hEl('health-reinstall-cert-btn');
    if (btn) {
      btn.disabled = true;
      btn.dataset.oldText = btn.textContent;
      btn.textContent = '重装中...';
    }
    setInstallCertButtonState('busy');
    try {
      const msg = await invoke('cert_reinstall_clean');
      setCertInstallProgress({ message: msg || 'CA 清理并重装完成', percent: 100, level: 'ok' });
      addLog && addLog('ok', 'CA 清理并重装: ' + msg);
      await window.runHealthcheck();
    } catch (e) {
      const errMsg = String(e);
      setCertInstallProgress({ message: '清理并重装失败: ' + errMsg, percent: 100, level: 'err' });
      addLog && addLog('err', 'CA 清理并重装失败: ' + errMsg);
      if (errMsg.includes('取消') || errMsg.includes('拒绝')) {
        showCustomAlert && showCustomAlert(
          '你取消了 UAC 授权（或拒绝访问）。证书可能未完整安装。\n\n请再次点击「清理并重装」，并在 UAC 弹窗中选择「是」。',
          'CA 重装被取消',
          'warning'
        );
      }
    } finally {
      setInstallCertButtonState('idle');
      if (btn) {
        btn.disabled = false;
        btn.textContent = btn.dataset.oldText || '清理并重装';
      }
    }
  };

  // ──────────────────────────────────────────────
  // 入口：用户点「卸载证书」按钮（测试用，常驻显示）
  // ──────────────────────────────────────────────
  window.uninstallCaFromHealth = async function () {
    if (!invoke) {
      try { if (typeof bindTauriBridge === 'function') bindTauriBridge(); } catch (_) {}
      if (!invoke) {
        setCertInstallProgress({ message: 'Tauri 通道未就绪，无法卸载证书', percent: 100, level: 'err' });
        addLog && addLog('err', 'CA 证书卸载失败: Tauri 通道未就绪');
        return;
      }
    }
    await ensureCertInstallProgressListener();
    _lastCertProgressMessage = '';
    setCertInstallProgress({ message: '准备卸载 CA 证书', percent: 3, level: 'warn' });
    addLog && addLog('warn', '正在卸载 CA 证书...');
    setUninstallCertButtonState('busy');
    try {
      const msg = await invoke('cert_uninstall');
      setCertInstallProgress({ message: msg || 'CA 证书卸载完成', percent: 100, level: 'ok' });
      addLog && addLog('ok', 'CA 证书卸载: ' + msg);
      await window.runHealthcheck();
    } catch (e) {
      const errMsg = String(e);
      setCertInstallProgress({ message: '卸载失败: ' + errMsg, percent: 100, level: 'err' });
      addLog && addLog('err', 'CA 证书卸载失败: ' + errMsg);
    } finally {
      setUninstallCertButtonState('idle');
    }
  };

  // ──────────────────────────────────────────────
  // 入口：用户点「清理老证书」按钮
  // ──────────────────────────────────────────────
  window.cleanupLegacyCaFromHealth = async function () {
    if (!invoke) return;
    const btn = _hEl('health-cleanup-legacy-btn');
    if (btn) { btn.disabled = true; btn.dataset.oldText = btn.textContent; btn.textContent = '清理中...'; }
    try {
      const msg = await invoke('cert_cleanup_legacy');
      addLog && addLog('ok', '老证书清理: ' + msg);
      await window.runHealthcheck();
    } catch (e) {
      addLog && addLog('err', '老证书清理失败: ' + e);
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = btn.dataset.oldText || '清理老证书'; }
    }
  };

  // ──────────────────────────────────────────────
  // 入口：导出 / 复制 Markdown 报告
  // ──────────────────────────────────────────────
  window.exportHealthMarkdown = async function () {
    const md = buildMarkdownReport(_lastReport);
    if (!md) return;
    const btn = _hEl('health-export-md-btn');
    if (btn) { btn.disabled = true; btn.dataset.oldText = btn.textContent; btn.textContent = '导出中...'; }
    try {
      const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
      const filename = 'byok-healthcheck-' + ts + '.md';
      // 优先用 Tauri save dialog
      try {
        if (window.__TAURI__ && window.__TAURI__.dialog && window.__TAURI__.dialog.save) {
          const path = await window.__TAURI__.dialog.save({
            defaultPath: filename,
            filters: [{ name: 'Markdown', extensions: ['md'] }],
          });
          if (path) {
            if (window.__TAURI__.fs && window.__TAURI__.fs.writeTextFile) {
              await window.__TAURI__.fs.writeTextFile(path, md);
              addLog && addLog('ok', '体检报告已保存: ' + path);
              return;
            }
          } else {
            return;
          }
        }
      } catch (e) {
        addLog && addLog('warn', 'Tauri 保存对话框不可用，退到浏览器下载: ' + e);
      }
      downloadTextFile(md, filename);
      addLog && addLog('ok', '体检报告已下载: ' + filename);
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = btn.dataset.oldText || '导出报告'; }
    }
  };

  window.copyHealthMarkdown = async function () {
    const md = buildMarkdownReport(_lastReport);
    if (!md) return;
    const btn = _hEl('health-copy-md-btn');
    if (btn) { btn.disabled = true; btn.dataset.oldText = btn.textContent; btn.textContent = '复制中...'; }
    try {
      await navigator.clipboard.writeText(md);
      addLog && addLog('ok', '体检报告已复制到剪贴板');
      if (btn) { btn.textContent = '✓ 已复制'; }
    } catch (e) {
      addLog && addLog('err', '复制到剪贴板失败: ' + e);
    } finally {
      if (btn) {
        setTimeout(() => { btn.disabled = false; btn.textContent = btn.dataset.oldText || '复制报告'; }, 800);
      }
    }
  };

  // ──────────────────────────────────────────────
  // 渲染：主入口
  // ──────────────────────────────────────────────
  const HEALTH_GROUP_SVGS = {
    path: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>`,
    cert: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg>`,
    port: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>`,
    sidecar: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="2" width="20" height="8" rx="2" ry="2"></rect><rect x="2" y="14" width="20" height="8" rx="2" ry="2"></rect><line x1="6" y1="6" x2="6.01" y2="6"></line><line x1="6" y1="18" x2="6.01" y2="18"></line></svg>`,
    resources: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"></path></svg>`,
    model_map: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="1 6 1 22 8 18 16 22 23 18 23 2 16 6 8 2 1 6"></polygon><line x1="8" y1="2" x2="8" y2="18"></line><line x1="16" y1="6" x2="16" y2="22"></line></svg>`,
    providers: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="2" y1="12" x2="22" y2="12"></line><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"></path></svg>`,
    other: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line></svg>`
  };

  function formatIssueMsg(msg) {
    if (!msg) return '';
    const raw = String(msg);
    const parts = raw.split('; ');
    if (parts.length > 1) {
      return parts.map(p => {
        const colonIdx = p.indexOf(': ');
        if (colonIdx > 0) {
          const k = p.slice(0, colonIdx);
          const v = p.slice(colonIdx + 2);
          return `<span class="health-kv-item"><span class="health-kv-key">${escapeHtml(k)}:</span> <code class="health-kv-val">${escapeHtml(v)}</code></span>`;
        }
        return `<span>${escapeHtml(p)}</span>`;
      }).join('<span class="health-kv-divider">·</span>');
    }
    return `<span>${escapeHtml(raw)}</span>`;
  }

  function renderGroupedReport(report) {
    if (!report) return;
    const ts = new Date(report.generatedAt || Date.now());
    const genAtEl = _hEl('health-generated-at');
    if (genAtEl) genAtEl.textContent = '更新时间: ' + formatTs(ts);

    const summaryText = report.ok
      ? `检测通过（全部检测项正常）`
      : `体检未通过（发现 ${report.totals.err} 项异常，${report.totals.warn} 项提示）`;

    setHealthSummary(summaryText, report.ok ? 'ok' : (report.totals.err > 0 ? 'err' : 'warn'));

    const container = _hEl('health-groups');
    if (!container) return;
    container.innerHTML = report.groups
      .filter((g) => g.issues.length > 0)
      .map(renderGroupCard)
      .join('');

    // 安装/卸载按钮常驻；只根据体检结果决定是否显示「清理老证书」按钮。
    const certGroup = report.groups.find((g) => g.id === 'cert');
    const hasLegacy = certGroup && certGroup.issues.some((i) => i.code === 'cert.legacy_residual');
    const cleanupBtn = _hEl('health-cleanup-legacy-btn');
    if (cleanupBtn) cleanupBtn.style.display = hasLegacy ? '' : 'none';
  }

  // ──────────────────────────────────────────────
  // 渲染：单个分组卡片
  // ──────────────────────────────────────────────
  function renderGroupCard(g) {
    const status = g.errors > 0 ? 'err' : (g.warnings > 0 ? 'warn' : 'ok');
    const svgIcon = HEALTH_GROUP_SVGS[g.id] || HEALTH_GROUP_SVGS.other;
    
    let badgeHtml = '';
    if (g.errors > 0) {
      badgeHtml = `<span class="health-badge err">${g.errors} 项异常</span>`;
    } else if (g.warnings > 0) {
      badgeHtml = `<span class="health-badge warn">${g.warnings} 项提示</span>`;
    } else {
      badgeHtml = `<span class="health-badge ok"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"></polyline></svg> 正常</span>`;
    }

    const issuesHtml = g.issues.map((i) => {
      const lvl = i.level || 'info';
      const lvlBadge = lvl === 'err' 
        ? `<span class="health-issue-tag err">错误</span>`
        : (lvl === 'warn' 
          ? `<span class="health-issue-tag warn">提示</span>`
          : `<span class="health-issue-tag ok">通过</span>`);
      return `
        <div class="health-issue">
          ${lvlBadge}
          <div class="health-issue-msg">${formatIssueMsg(i.message || String(i))}</div>
        </div>
      `;
    }).join('');

    return `
      <div class="health-group-card health-status-${status}">
        <div class="health-group-head">
          <div class="health-group-title-wrap">
            <span class="health-group-icon">${svgIcon}</span>
            <span class="health-group-title">${escapeHtml(g.title)}</span>
          </div>
          <div class="health-group-status">${badgeHtml}</div>
        </div>
        <div class="health-group-issues">${issuesHtml}</div>
      </div>
    `;
  }

  function setHealthSummary(text, kind) {
    const el = _hEl('health-summary');
    if (!el) return;
    const isOk = kind === 'ok';
    const isErr = kind === 'err';
    const isWarn = kind === 'warn';
    const isPending = kind === 'pending';

    let iconSvg = '';
    if (isOk) {
      iconSvg = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"></polyline></svg>`;
    } else if (isErr) {
      iconSvg = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"></circle><line x1="15" y1="9" x2="9" y2="15"></line><line x1="9" y1="9" x2="15" y2="15"></line></svg>`;
    } else if (isWarn) {
      iconSvg = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>`;
    } else if (isPending) {
      iconSvg = `<svg class="spin" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="2" x2="12" y2="6"></line><line x1="12" y1="18" x2="12" y2="22"></line><line x1="4.93" y1="4.93" x2="7.76" y2="7.76"></line><line x1="16.24" y1="16.24" x2="19.07" y2="19.07"></line><line x1="2" y1="12" x2="6" y2="12"></line><line x1="18" y1="12" x2="22" y2="12"></line><line x1="4.93" y1="19.07" x2="7.76" y2="16.24"></line><line x1="16.24" y1="7.76" x2="19.07" y2="4.93"></line></svg>`;
    }

    el.innerHTML = `
      <div class="health-summary-inner status-${kind}">
        ${iconSvg ? `<span class="health-summary-icon">${iconSvg}</span>` : ''}
        <span class="health-summary-text">${escapeHtml(text)}</span>
      </div>
    `;
  }

  // ──────────────────────────────────────────────
  // 报告 → Markdown
  // ──────────────────────────────────────────────
  function buildMarkdownReport(report) {
    if (!report) {
      addLog && addLog('warn', '暂无体检报告，请先点「一键体检」');
      return null;
    }
    const ts = new Date(report.generatedAt || Date.now());
    const lines = [];
    lines.push('# AnyBridge 环境体检报告');
    lines.push('');
    lines.push('- 体检时间: ' + ts.toLocaleString());
    lines.push('- 目标 IDE: ' + (report.targetIde || '(未指定)'));
    lines.push('- 体检结果: ' + (report.ok ? '✅ 通过' : '❌ 未通过'));
    lines.push('- 总计: ' + report.totals.err + ' 错误 / ' + report.totals.warn + ' 警告 / ' + report.totals.ok + ' 通过');
    lines.push('');
    lines.push('## 汇总');
    lines.push('');
    for (const g of report.groups) {
      if (g.issues.length === 0) continue;
      const status = g.errors > 0 ? '❌' : g.warnings > 0 ? '⚠' : '✅';
      lines.push('- ' + status + ' **' + g.title + '** — ' + g.errors + ' 错 / ' + g.warnings + ' 警 / ' + g.oks + ' 通');
    }
    lines.push('');
    for (const g of report.groups) {
      if (g.issues.length === 0) continue;
      const status = g.errors > 0 ? '❌' : g.warnings > 0 ? '⚠' : '✅';
      lines.push('## ' + g.icon + ' ' + g.title + '  ' + status);
      lines.push('');
      for (const i of g.issues) {
        const lvl = i.level === 'err' ? '❌' : i.level === 'warn' ? '⚠' : '✅';
        lines.push('- ' + lvl + ' ' + (i.message || ''));
      }
      lines.push('');
    }
    return lines.join('\n');
  }

  // ──────────────────────────────────────────────
  // 工具
  // ──────────────────────────────────────────────
  function setInstallCertButtonState(state) {
    const btn = _hEl('health-install-cert-btn');
    const uninstallBtn = _hEl('health-uninstall-cert-btn');
    if (state === 'busy') {
      if (btn) {
        btn.disabled = true;
        btn.textContent = '安装中...';
      }
      if (uninstallBtn) uninstallBtn.disabled = true;
    } else {
      if (btn) {
        btn.disabled = false;
        btn.textContent = '安装证书';
      }
      if (uninstallBtn) uninstallBtn.disabled = false;
    }
  }
  function setUninstallCertButtonState(state) {
    const btn = _hEl('health-uninstall-cert-btn');
    const installBtn = _hEl('health-install-cert-btn');
    if (state === 'busy') {
      if (btn) {
        btn.disabled = true;
        btn.textContent = '卸载中...';
      }
      if (installBtn) installBtn.disabled = true;
    } else {
      if (btn) {
        btn.disabled = false;
        btn.textContent = '卸载证书';
      }
      if (installBtn) installBtn.disabled = false;
    }
  }
  async function ensureCertInstallProgressListener() {
    if (_certInstallProgressUnlisten || !tauriEvent?.listen) return;
    try {
      _certInstallProgressUnlisten = await tauriEvent.listen('cert-install-progress', (event) => {
        const payload = event.payload || {};
        setCertInstallProgress(payload);
        if (payload.message && payload.message !== _lastCertProgressMessage) {
          _lastCertProgressMessage = payload.message;
          const level = payload.level === 'err' ? 'err' : (payload.level === 'warn' ? 'warn' : (payload.level === 'ok' ? 'ok' : 'info'));
          addLog && addLog(level, '证书操作: ' + payload.message);
        }
      });
    } catch (e) {
      addLog && addLog('warn', '证书安装进度监听不可用: ' + e);
    }
  }
  function setCertInstallProgress(payload) {
    const panel = _hEl('health-install-progress');
    if (!panel) return;
    const text = _hEl('health-install-progress-text');
    const percentEl = _hEl('health-install-progress-percent');
    const fill = _hEl('health-install-progress-fill');
    const percent = Math.max(0, Math.min(100, Number(payload?.percent ?? 0)));
    const level = payload?.level || 'info';
    panel.hidden = false;
    panel.classList.toggle('is-ok', level === 'ok');
    panel.classList.toggle('is-err', level === 'err');
    panel.classList.toggle('is-warn', level === 'warn');
    if (text) text.textContent = payload?.message || '正在安装 CA 证书';
    if (percentEl) percentEl.textContent = Math.round(percent) + '%';
    if (fill) fill.style.width = percent + '%';
  }
  function enableExportButtons(enabled) {
    const a = _hEl('health-export-md-btn');
    const b = _hEl('health-copy-md-btn');
    if (a) a.disabled = !enabled;
    if (b) b.disabled = !enabled;
  }
  function formatTs(d) {
    const pad = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
      ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
  }
  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }
  function renderHealthSkeleton(count = 4) {
    const cards = [];
    for (let i = 0; i < count; i++) {
      cards.push(`
        <div class="health-group-card health-skeleton-card" aria-hidden="true" style="--delay:${i * 60}ms">
          <div class="health-group-head">
            <span class="health-skeleton-icon"></span>
            <span class="health-skeleton-line title"></span>
            <span class="health-skeleton-line status"></span>
          </div>
          <div class="health-group-issues">
            <div class="health-skeleton-issue">
              <span class="health-skeleton-line tag"></span>
              <span class="health-skeleton-line msg"></span>
            </div>
            <div class="health-skeleton-issue">
              <span class="health-skeleton-line tag"></span>
              <span class="health-skeleton-line msg short"></span>
            </div>
          </div>
        </div>
      `);
    }
    return cards.join('');
  }

  function downloadTextFile(text, filename) {
    const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }
})();
