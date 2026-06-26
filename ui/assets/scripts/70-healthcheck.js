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

    setHealthSummary('检测进行中...', 'pending');
    addLog && addLog('ok', '环境检测: 正在执行（首次可能需要 1-2 秒）...');

    try {
      const report = await invoke('healthcheck_grouped', { targetIde: target });
      _lastReport = report;
      renderGroupedReport(report);
      enableExportButtons(true);
      addLog && addLog('ok', `环境检测: 完成 (${report.totals.err} 错误 / ${report.totals.warn} 警告 / ${report.totals.ok} 通过)`);
    } catch (e) {
      setHealthSummary('❌ 检测失败: ' + escapeHtml(String(e)), 'err');
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
    try {
      const msg = await invoke('cert_cleanup_legacy');
      addLog && addLog('ok', '老证书清理: ' + msg);
      await window.runHealthcheck();
    } catch (e) {
      addLog && addLog('err', '老证书清理失败: ' + e);
    }
  };

  // ──────────────────────────────────────────────
  // 入口：导出 / 复制 Markdown 报告
  // ──────────────────────────────────────────────
  window.exportHealthMarkdown = async function () {
    const md = buildMarkdownReport(_lastReport);
    if (!md) return;
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
  };

  window.copyHealthMarkdown = async function () {
    const md = buildMarkdownReport(_lastReport);
    if (!md) return;
    try {
      await navigator.clipboard.writeText(md);
      addLog && addLog('ok', '体检报告已复制到剪贴板');
    } catch (e) {
      addLog && addLog('err', '复制到剪贴板失败: ' + e);
    }
  };

  // ──────────────────────────────────────────────
  // 渲染：主入口
  // ──────────────────────────────────────────────
  function renderGroupedReport(report) {
    if (!report) return;
    const ts = new Date(report.generatedAt || Date.now());
    const genAtEl = _hEl('health-generated-at');
    if (genAtEl) genAtEl.textContent = '更新时间: ' + formatTs(ts);

    setHealthSummary(
      (report.ok ? '✅ 体检通过' : '❌ 体检未通过') + '  ' +
      '错误 ' + report.totals.err + ' · 警告 ' + report.totals.warn + ' · 通过 ' + report.totals.ok,
      report.ok ? 'ok' : (report.totals.err > 0 ? 'err' : 'warn')
    );

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
    const statusIcon = status === 'err' ? '❌' : status === 'warn' ? '⚠' : '✅';
    const statusColor = status === 'err' ? 'var(--danger)' : status === 'warn' ? 'var(--warning)' : 'var(--success)';
    const issueCount = g.errors + ' 错 / ' + g.warnings + ' 警 / ' + g.oks + ' 通';
    const issuesHtml = g.issues.map((i) => {
      const lvl = i.level || 'info';
      const color = lvl === 'err' ? 'var(--danger)' : lvl === 'warn' ? 'var(--warning)' : 'var(--success)';
      const label = lvl === 'err' ? '错误' : lvl === 'warn' ? '提示' : lvl === 'ok' ? '通过' : '信息';
      return '<div class="health-issue">' +
        '<span class="health-issue-level" style="color:' + color + '">' + label + '</span>' +
        '<span class="health-issue-msg">' + escapeHtml(i.message || String(i)) + '</span>' +
        '</div>';
    }).join('');
    return '<div class="health-group-card health-status-' + status + '">' +
      '<div class="health-group-head">' +
        '<span class="health-group-icon">' + g.icon + '</span>' +
        '<span class="health-group-title">' + escapeHtml(g.title) + '</span>' +
        '<span class="health-group-status" style="color:' + statusColor + '">' + statusIcon + ' ' + issueCount + '</span>' +
      '</div>' +
      '<div class="health-group-issues">' + issuesHtml + '</div>' +
    '</div>';
  }

  function setHealthSummary(text, kind) {
    const el = _hEl('health-summary');
    if (!el) return;
    const color = kind === 'err' ? 'var(--danger)' : kind === 'warn' ? 'var(--warning)' : kind === 'ok' ? 'var(--success)' : 'var(--text-secondary)';
    el.innerHTML = '<div class="health-summary-line" style="color:' + color + '">' + escapeHtml(text) + '</div>';
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
