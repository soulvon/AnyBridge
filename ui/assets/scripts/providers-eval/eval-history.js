// providers-eval/eval-history.js — 评测进度监听、诊断报告渲染与历史对比矩阵
import { escAttr, escapeHtml } from '../ui/dom.js';

function resetEvalReportChrome() {
  currentEvalProgressId = '';
  setEvalText('eval-report-state', '未开始');
  setEvalText('eval-report-target', '请选择供应商和模型');
  setEvalText('eval-report-id', '--');
  setEvalText('eval-report-clock', '--');
  setEvalText('eval-progress-text', '等待检测');
  setEvalText('eval-progress-score', '--');
  setEvalText('eval-footnote-left', '暂无报告');
  setEvalText('eval-footnote-right', '本机检测 · 完整探针');
  const fill = document.getElementById('eval-progress-fill');
  if (fill) fill.style.width = '0%';
  document.querySelector('.eval-progress-panel')?.classList.remove('is-running');
  const state = document.getElementById('eval-report-state');
  if (state) state.dataset.state = 'idle';
  updateEvalRadar(0, EVAL_DIMENSIONS.map(dim => ({ ...dim, score: 0, probes: [] })));
  renderEvalDimensions([]);
  setEvalText('eval-diagnosis-level', '综合判定');
  const diagnosis = document.getElementById('eval-diagnosis-list');
  if (diagnosis) diagnosis.innerHTML = '';
  const capCard = document.getElementById('eval-cap-card');
  if (capCard) capCard.classList.add('no-caps');
  setEvalText('eval-cap-limit', '未命中硬上限');
  const capBox = document.getElementById('eval-caps');
  if (capBox) capBox.innerHTML = '<div class="eval-cap-row eval-cap-row-ok"><span class="eval-cap-pill">OK</span><div><strong>暂无硬上限命中</strong><small>完整检测完成后显示封顶规则</small></div></div>';
  renderEvalChecks('eval-capability-checks', [], '完整检测完成后显示能力支持情况');
  renderEvalChecks('eval-protocol-checks', [], '完整检测完成后显示调用方式兼容情况');
}

function renderEvalRunning(provider, model, apiFormat = getEvalApiFormat()) {
  currentEvalProgressId = '';
  const protocol = evalApiFormatLabel(apiFormat);
  const empty = document.getElementById('eval-empty');
  const result = document.getElementById('eval-result');
  if (empty) {
    empty.style.display = 'grid';
    empty.innerHTML = loadingHtml('正在执行全面检测…');
  }
  if (result) result.style.display = 'none';
  {
    // 加载态必须动态（开发规范）：静态「检测中」看起来像卡住
    const _st = document.getElementById('eval-report-state');
    if (_st) _st.innerHTML = loadingHtml('检测中…');
  }
  setEvalText('eval-report-target', `${provider?.name || '--'} · ${model || '--'} · ${protocol} · 全面检测`);
  setEvalText('eval-report-id', 'pending');
  setEvalText('eval-report-clock', evalFormatTime(Date.now()));
  setEvalText('eval-progress-text', '准备执行完整探针');
  setEvalText('eval-progress-score', `0 / ${getEvalTotalForSelected()}`);
  const state = document.getElementById('eval-report-state');
  if (state) state.dataset.state = 'running';
  const fill = document.getElementById('eval-progress-fill');
  if (fill) fill.style.width = '2%';
  document.querySelector('.eval-progress-panel')?.classList.add('is-running');
}

function renderEvalFailure(provider, model, message, apiFormat = getEvalApiFormat()) {
  const protocol = evalApiFormatLabel(apiFormat);
  const empty = document.getElementById('eval-empty');
  const result = document.getElementById('eval-result');
  if (empty) {
    empty.style.display = 'grid';
    empty.textContent = '检测失败，请查看日志';
  }
  if (result) result.style.display = 'none';
  setEvalText('eval-report-state', '失败');
  setEvalText('eval-report-target', `${provider?.name || '--'} · ${model || '--'} · ${protocol}`);
  setEvalText('eval-report-id', '--');
  setEvalText('eval-report-clock', evalFormatTime(Date.now()));
  setEvalText('eval-progress-text', String(message || '检测失败').slice(0, 80));
  setEvalText('eval-progress-score', '--');
  const state = document.getElementById('eval-report-state');
  if (state) state.dataset.state = 'fail';
  const fill = document.getElementById('eval-progress-fill');
  if (fill) fill.style.width = '0%';
  document.querySelector('.eval-progress-panel')?.classList.remove('is-running');
}

function applyEvalProgress(payload) {
  if (!payload || !evalRunning) return;
  if (!currentEvalProgressId && payload.reportId) {
    currentEvalProgressId = payload.reportId;
    setEvalText('eval-report-id', payload.reportId);
  }
  if (currentEvalProgressId && payload.reportId && payload.reportId !== currentEvalProgressId) return;
  const completed = Number(payload.completed || 0);
  const total = Number(payload.total || 0) || getEvalTotalForSelected();
  const percent = Math.max(2, Math.min(98, Math.round((completed / total) * 100)));
  const fill = document.getElementById('eval-progress-fill');
  if (fill) fill.style.width = `${percent}%`;
  setEvalText('eval-progress-score', `${Math.min(completed, total)} / ${total}`);
  if (payload.phase === 'started') {
    setEvalText('eval-progress-text', '开始执行完整探针');
    return;
  }
  if (payload.phase === 'finished') {
    setEvalText('eval-progress-text', '正在生成报告');
    setEvalText('eval-progress-score', `${total} / ${total}`);
    if (fill) fill.style.width = '100%';
    return;
  }
  const probe = [payload.probeId, payload.probeName].filter(Boolean).join(' ');
  const status = payload.status ? ` · ${evalStatusLabel(payload.status)}` : '';
  const score = payload.status && payload.status !== 'skip' ? ` · ${Number(payload.score || 0).toFixed(0)}分` : '';
  setEvalText('eval-progress-text', `${probe || '探针完成'}${status}${score}`);
}

async function bindEvalProgressListener() {
  if (!tauriEvent?.listen || evalProgressUnlisten) return;
  evalProgressUnlisten = await tauriEvent.listen('provider-eval-progress', (event) => {
    applyEvalProgress(event.payload || {});
  });
}

function renderEvalReport(report) {
  const empty = document.getElementById('eval-empty');
  const result = document.getElementById('eval-result');
  if (!report) {
    currentEvalReportId = '';
    if (empty) {
      empty.style.display = 'grid';
      empty.textContent = '暂无报告';
    }
    if (result) result.style.display = 'none';
    ['eval-score', 'eval-risk', 'eval-requests', 'eval-duration', 'eval-reported-model', 'eval-token-speed', 'eval-ttft', 'eval-output-tokens', 'eval-score-cap-count', 'eval-score-probe-count', 'eval-score-model-relation'].forEach(id => {
      const el = document.getElementById(id);
      if (el) {
        el.textContent = '--';
        el.style.color = '';
        el.title = '';
      }
    });
    const riskStat = document.querySelector('.eval-stat-risk');
    if (riskStat) delete riskStat.dataset.level;
    const meta = document.getElementById('eval-report-meta');
    if (meta) meta.textContent = '--';
    resetEvalReportChrome();
    renderEvalHistory();
    return;
  }

  currentEvalReportId = report.id || '';
  if (empty) empty.style.display = 'none';
  if (result) result.style.display = 'grid';

  const score = Number(report.score || 0);
  const scoreEl = document.getElementById('eval-score');
  if (scoreEl) scoreEl.textContent = score.toFixed(0);
  const riskEl = document.getElementById('eval-risk');
  if (riskEl) {
    riskEl.textContent = evalScoreBand(score);
    riskEl.style.color = evalRiskColor(report.riskLevel);
  }
  const riskStat = document.querySelector('.eval-stat-risk');
  if (riskStat) riskStat.dataset.level = report.riskLevel || '';
  const requestEl = document.getElementById('eval-requests');
  if (requestEl) requestEl.textContent = String(report.usage?.requestCount || 0);
  const durationEl = document.getElementById('eval-duration');
  if (durationEl) durationEl.textContent = evalFormatDuration(report.durationMs);
  const metrics = report.metrics || {};
  const reportedModel = report.reportedModel || '';
  const relation = metrics.modelRelation || (reportedModel ? 'unknown' : 'unknown');
  const reportedEl = document.getElementById('eval-reported-model');
  if (reportedEl) {
    reportedEl.textContent = reportedModel || '--';
    reportedEl.title = reportedModel
      ? `请求模型: ${report.model || '--'}\n响应模型: ${reportedModel}\n关系: ${evalRelationLabel(relation)}`
      : '响应中未发现 model 字段';
  }
  const speedEl = document.getElementById('eval-token-speed');
  if (speedEl) {
    const tps = metrics.tokensPerSecond;
    speedEl.textContent = Number.isFinite(Number(tps)) ? Number(tps).toFixed(1) : '--';
  }
  const ttftEl = document.getElementById('eval-ttft');
  if (ttftEl) ttftEl.textContent = metrics.ttftMs == null ? '--' : evalFormatDuration(metrics.ttftMs);
  const outputEl = document.getElementById('eval-output-tokens');
  if (outputEl) {
    const outputTokens = metrics.throughputTokens ?? report.usage?.outputTokens;
    outputEl.textContent = outputTokens == null ? '--' : String(outputTokens);
  }
  const meta = document.getElementById('eval-report-meta');
  if (meta) {
    const protocol = evalApiFormatLabel(report.apiFormat);
    const modelMeta = reportedModel && reportedModel !== report.model
      ? `${report.model || '--'} → ${reportedModel}`
      : (report.model || reportedModel || '--');
    meta.textContent = `${report.providerName || '--'} · ${modelMeta} · ${protocol} · 全面检测 · 触发 ${Array.isArray(report.caps) ? report.caps.length : 0} 条 cap`;
  }
  const verdict = document.getElementById('eval-verdict');
  if (verdict) verdict.textContent = report.verdict || '--';

  const caps = Array.isArray(report.caps) ? report.caps : [];
  const capBox = document.getElementById('eval-caps');
  const capCard = document.getElementById('eval-cap-card');
  const capLimit = document.getElementById('eval-cap-limit');
  if (capCard) capCard.classList.toggle('no-caps', !caps.length);
  if (capLimit) {
    capLimit.textContent = caps.length
      ? `最严上限 ≤ ${Math.min(...caps.map(c => Number(c.capValue || 0))).toFixed(0)} 分`
      : '未命中硬上限';
  }
  if (capBox) {
    capBox.innerHTML = caps.length
      ? caps.map(c => `
        <div class="eval-cap-row">
          <span class="eval-cap-pill">≤ ${Number(c.capValue || 0).toFixed(0)}</span>
          <div>
            <strong>${escAttr(c.reason || c.rule || '硬上限规则命中')}</strong>
            <small>规则: ${escAttr(c.rule || '--')}</small>
          </div>
        </div>`).join('')
      : '<div class="eval-cap-row eval-cap-row-ok"><span class="eval-cap-pill">OK</span><div><strong>无硬上限命中</strong><small>综合分未被 cap 规则压低</small></div></div>';
  }
  setEvalText('eval-score-cap-count', `${caps.length} 条`);
  const probesForCount = Array.isArray(report.probes) ? report.probes : [];
  const executedCount = probesForCount.filter(p => p.status !== 'skip').length;
  const skippedCount = probesForCount.length - executedCount;
  setEvalText('eval-score-probe-count', skippedCount ? `${executedCount}/${probesForCount.length}` : `${executedCount} 项`);
  setEvalText('eval-score-model-relation', evalRelationLabel(relation));

  const dimensions = evalDimensionScores(report);
  updateEvalRadar(score, dimensions);
  renderEvalDimensions(dimensions);
  renderEvalDiagnosis(report, dimensions);
  renderEvalChecks('eval-capability-checks', report.capabilityChecks, '该报告没有能力矩阵');
  renderEvalChecks('eval-protocol-checks', report.protocolChecks, '该报告没有协议矩阵');
  setEvalText('eval-report-state', '已完成');
  setEvalText('eval-report-target', `${report.providerName || '--'} · ${report.model || '--'} · ${evalApiFormatLabel(report.apiFormat)} · 全面检测`);
  setEvalText('eval-report-id', report.id || '--');
  setEvalText('eval-report-clock', evalFormatTime(report.createdAt));
  const offlineCap = caps.find(c => c.rule === 'protocol_offline');
  const allProbes = Array.isArray(report.probes) ? report.probes : [];
  if (offlineCap) {
    const p1probe = allProbes.find(p => p.id === 'P1');
    const failSummary = p1probe?.summary || '协议不可用';
    setEvalText('eval-progress-text', `协议失败：${failSummary}`);
    setEvalText('eval-progress-score', `${score.toFixed(0)} / 100`);
    const state = document.getElementById('eval-report-state');
    if (state) state.dataset.state = 'warn';
  } else {
    setEvalText('eval-progress-text', '检测完成');
    setEvalText('eval-progress-score', `${score.toFixed(0)} / 100`);
    const state = document.getElementById('eval-report-state');
    if (state) state.dataset.state = 'done';
  }
  const fill = document.getElementById('eval-progress-fill');
  if (fill) fill.style.width = '100%';
  document.querySelector('.eval-progress-panel')?.classList.remove('is-running');
  setEvalText('eval-footnote-left', `报告 ID ${report.id || '--'} · ${report.providerName || '--'} · ${evalApiFormatLabel(report.apiFormat)} · ${evalFormatTime(report.createdAt)}`);
  setEvalText('eval-footnote-right', `本机检测 · 全面探针 · 请求 ${report.usage?.requestCount || 0} · 耗时 ${evalFormatDuration(report.durationMs)}`);

  const body = document.getElementById('eval-probe-body');
  if (body) {
    const probes = Array.isArray(report.probes) ? report.probes : [];
    body.innerHTML = probes.map(p => {
      const evidence = Array.isArray(p.evidence) ? p.evidence : [];
      const evidenceHtml = evidence.length
        ? `<div class="eval-evidence">${evidence.map(x => escAttr(x)).join('<br>')}</div>`
        : '';
      const latency = p.latencyMs == null ? '--' : `${p.latencyMs}ms`;
      const scoreText = p.status === 'skip' ? '--' : Number(p.score || 0).toFixed(1);
      const key = String(p.status || 'skip').toLowerCase();
      return `
        <tr class="eval-probe-row status-${escAttr(key)}">
          <td><span style="font-family:var(--font-mono);font-weight:800;">${escAttr(p.id || '')}</span><div style="font-size:12px;color:var(--text-muted);margin-top:3px;">${escAttr(p.name || '')}</div></td>
          <td>${evalStatusTag(p.status)}</td>
          <td style="font-family:var(--font-mono);font-weight:700;">${scoreText}</td>
          <td style="font-family:var(--font-mono);color:var(--text-muted);">${latency}</td>
          <td><div style="font-size:12px;color:var(--text-secondary);line-height:1.45;">${escAttr(p.summary || '')}</div>${evidenceHtml}</td>
        </tr>`;
    }).join('');
  }
  renderEvalHistory();
}

function renderEvalHistory() {
  const list = document.getElementById('eval-history-list');
  ['evalReportCount', 'evalHistoryPageCount'].forEach(id => {
    const count = document.getElementById(id);
    if (count) count.textContent = `${evalReports.length} 份报告`;
  });
  if (!list) return;
  if (!evalReports.length) {
    list.innerHTML = '<div class="eval-empty-state">暂无历史</div>';
    return;
  }
  list.innerHTML = evalReports.map(r => {
    const active = r.id === currentEvalReportId ? ' active' : '';
    const reportedModel = r.reportedModel || '';
    const modelLine = reportedModel && reportedModel !== r.model
      ? `${r.model || '--'} → ${reportedModel}`
      : (r.model || reportedModel || '--');
    const protocol = evalApiFormatLabel(r.apiFormat);
    return `
      <div class="eval-history-item${active}" data-action="selectEvalReport" data-arg="${escAttr(r.id)}">
        <div class="eval-history-top">
          <div class="eval-history-name">
            <div class="eval-history-provider">${escAttr(r.providerName || '--')}</div>
            <div class="eval-history-model" title="${escAttr(`${modelLine} · ${protocol}`)}">${escAttr(modelLine)} · ${escAttr(protocol)}</div>
          </div>
          <div class="eval-history-score" style="color:${evalRiskColor(r.riskLevel)};">${Number(r.score || 0).toFixed(1)}</div>
        </div>
        <div class="eval-history-meta">
          <span class="eval-history-time">${evalFormatTime(r.createdAt)}</span>
          <button class="btn-ghost eval-history-delete" data-action="deleteEvalReport" data-args="[&quot;${escAttr(r.id)}&quot;]" data-pass-event>删除</button>
        </div>
      </div>`;
  }).join('');
}

function selectEvalReport(id) {
  const report = evalReports.find(r => r.id === id);
  if (!report) return;
  renderEvalReport(report);
  openEvalWorkbenchPage();
}

function openEvalHistoryPage() {
  navigateTo('eval-history');
  renderEvalHistory();
}

function openEvalWorkbenchPage() {
  navigateTo('eval');
}

async function loadEvalReports() {
  if (!invoke) {
    evalReports = [];
    renderEvalHistory();
    return;
  }
  try {
    evalReports = await invoke('list_eval_reports') || [];
    const current = evalReports.find(r => r.id === currentEvalReportId);
    renderEvalReport(current || evalReports[0] || null);
  } catch (e) {
    evalReports = [];
    renderEvalHistory();
    addLog('warn', '检测报告加载失败: ' + e);
  }
}

function setEvalRunning(running) {
  evalRunning = running;
  const btn = document.getElementById('evalRunBtn');
  if (!btn) return;
  btn.classList.toggle('running', running);
  btn.style.opacity = running ? '.72' : '1';
  btn.style.cursor = running ? 'default' : 'pointer';
  if (running) {
    if (typeof setLoading === 'function') {
      setLoading(btn, '检测中…');
    } else if (typeof loadingHtml === 'function') {
      if (btn.dataset.prevHtml === undefined) btn.dataset.prevHtml = btn.innerHTML;
      btn.disabled = true;
      btn.innerHTML = loadingHtml('检测中…');
    }
    return;
  }
  if (typeof clearLoading === 'function' && btn.dataset.prevHtml !== undefined) {
    clearLoading(btn);
  } else {
    btn.disabled = false;
    if (btn.dataset.prevHtml !== undefined) {
      btn.innerHTML = btn.dataset.prevHtml;
      delete btn.dataset.prevHtml;
    } else {
      btn.textContent = '开始检测';
    }
  }
}

function evalReportProtocolConnected(report) {
  const p1 = Array.isArray(report?.probes) ? report.probes.find(p => p.id === 'P1') : null;
  const status = String(p1?.status || '').toLowerCase();
  return status === 'pass' || status === 'warn';
}

function evalReportProtocolSummary(report) {
  const p1 = Array.isArray(report?.probes) ? report.probes.find(p => p.id === 'P1') : null;
  return p1?.summary || report?.verdict || '协议连通性未通过';
}

function rememberEvalReport(report) {
  if (!report?.id) return;
  evalReports = [report, ...evalReports.filter(r => r.id !== report.id)].slice(0, 20);
}

async function runProviderEvalRequest(providerId, model, mode, selectedChecks, apiFormat) {
  return await invoke('run_provider_eval', {
    request: { providerId, model, apiFormat, mode, selectedChecks }
  });
}

async function startEval() {
  if (evalRunning) return;
  const providerId = document.getElementById('eval-provider-select')?.value || '';
  const model = document.getElementById('eval-model-select')?.value || '';
  const apiFormat = getEvalApiFormat();
  const mode = 'standard';
  const selectedChecks = getSelectedEvalChecks();
  const provider = getEvalProvider(providerId);
  if (!provider || !model) {
    showCustomAlert('请选择已启用的供应商和模型。', '无法检测', 'warn');
    return;
  }

  setEvalRunning(true);
  renderEvalRunning(provider, model, apiFormat);
  addLog('info', `开始检测「${provider.name} / ${model}」· ${evalApiFormatLabel(apiFormat)}`);
  try {
    let report = null;
    if (apiFormat === 'auto') {
      const isGeminiHint = (model || '').toLowerCase().includes('gemini') || (provider.apiHost || '').toLowerCase().includes('gemini') || (provider.apiHost || '').toLowerCase().includes('googleapis');
      const tryOrder = isGeminiHint ? ['gemini', 'openai', 'anthropic'] : ['openai', 'anthropic', 'gemini'];
      for (const fmt of tryOrder) {
        renderEvalRunning(provider, model, fmt);
        addLog('info', `自动协议：尝试按 ${evalApiFormatLabel(fmt)} 检测`);
        let currentReport = null;
        try {
          currentReport = await runProviderEvalRequest(providerId, model, mode, selectedChecks, fmt);
          rememberEvalReport(currentReport);
        } catch (e) {
          addLog('warn', `自动协议：${evalApiFormatLabel(fmt)} 请求异常（${e}）`);
        }
        if (currentReport && evalReportProtocolConnected(currentReport)) {
          report = currentReport;
          addLog('ok', `自动协议：${evalApiFormatLabel(fmt)} 已通过，检测成功`);
          break;
        }
      }
      if (!report) {
        // 如果三者都未通过，保留最后一个尝试的报告
        report = await runProviderEvalRequest(providerId, model, mode, selectedChecks, tryOrder[0]);
        rememberEvalReport(report);
      }
    } else {
      report = await runProviderEvalRequest(providerId, model, mode, selectedChecks, apiFormat);
      rememberEvalReport(report);
    }
    renderEvalReport(report);
    await loadEvalReports();
    const doneLevel = evalReportProtocolConnected(report) ? 'ok' : 'warn';
    addLog(doneLevel, `检测完成：${provider.name} / ${model} · ${evalApiFormatLabel(report.apiFormat)}，得分 ${Number(report.score || 0).toFixed(1)}`);
  } catch (e) {
    addLog('err', '检测失败: ' + e);
    renderEvalFailure(provider, model, e, apiFormat);
    showCustomAlert(String(e), '检测失败', 'error');
  } finally {
    setEvalRunning(false);
  }
}

async function deleteEvalReport(id, event) {
  if (event) event.stopPropagation();
  if (!id) return;
  try {
    evalReports = await invoke('delete_eval_report', { id }) || [];
    renderEvalReport(evalReports[0] || null);
    addLog('info', '已删除检测报告');
  } catch (e) {
    addLog('err', '删除检测报告失败: ' + e);
  }
}

async function toggleProviderEnabled(id) {
  if (!invoke) return;
  const key = 'provider:' + id;
  if (_inFlightToggles.has(key)) return;
  const p = providerStore.providers.find(x => x.id === id);
  if (!p) return;
  if (p.meta?.codexConfig === true) {
    showCustomAlert('这是 Codex 配置，不属于供应商启用状态。', '无法操作', 'warn');
    return;
  }
  if (isBuiltinProvider(p)) {
    showCustomAlert('内置供应商不可禁用。', '无法操作', 'warn');
    return;
  }
  const next = !(p.enabled !== false);
  _inFlightToggles.add(key);
  try {
    await invoke('set_provider_enabled', { id, enabled: next });
    p.enabled = next;
    renderProviders();
    renderEvalProviderOptions();
    await renderModelMap();
    addLog('ok', `供应商「${p.name}」已${next ? '启用' : '禁用'}`);
  } catch (e) {
    addLog('err', '启用状态切换失败: ' + e);
  } finally {
    _inFlightToggles.delete(key);
  }
}

async function deleteProvider(id) {
  const p = (providerStore?.providers || []).find(x => x.id === id);
  if (p?.meta?.codexConfig === true) {
    showCustomAlert('这是 Codex 配置，请在 Codex 配置页删除。', '无法删除供应商', 'warn');
    return;
  }
  if (isBuiltinProvider(p)) {
    showCustomAlert('内置供应商不可删除。', '无法删除供应商', 'warn');
    return;
  }
  const ok = await mutateProviderStore(store => {
    store.providers = (store.providers || []).filter(x => x.id !== id);
  }, { alertOnError: true });
  renderProviders();
  renderEvalProviderOptions();
  await renderModelMap();
  if (!ok) return;
  addLog('info', '已删除供应商');
}

function copyLocalProxyInfo() {
  const p = providerStore.providers.find(x => x.id === LOCAL_PROXY_PROVIDER_ID);
  if (!p) return;
  const info = [
    `名称: ${p.name}`,
    `API Host: ${p.apiHost}`,
    `API Path: ${p.apiPath}`,
    `API Key: ${p.apiKey || '(空)'}`,
    `默认模型: ${p.defaultModel || '(无)'}`,
    `可用模型: ${(p.models || []).join(', ') || '(无)'}`,
  ].join('\n');
  navigator.clipboard?.writeText(info).then(() => {
    showCustomAlert('连接信息已复制到剪贴板。', '复制成功', 'info');
  }).catch(() => {
    showCustomAlert(info, '连接信息', 'info');
  });
}

function navigateToProxyModels() {
  navigateTo('proxy');
  activateProxyPanel('routes');
}

function navigateToProxyEnhancement() {
  navigateTo('proxy');
  activateProxyPanel('enhancement');
  activateEnhancementPanel('vision');
}

syncEvalCombos();

// ---- P3 globalThis mirror ----
(function mirrorFns(g) {
  g.resetEvalReportChrome = resetEvalReportChrome;
  g.renderEvalRunning = renderEvalRunning;
  g.renderEvalFailure = renderEvalFailure;
  g.applyEvalProgress = applyEvalProgress;
  g.bindEvalProgressListener = bindEvalProgressListener;
  g.renderEvalReport = renderEvalReport;
  g.renderEvalHistory = renderEvalHistory;
  g.selectEvalReport = selectEvalReport;
  g.openEvalHistoryPage = openEvalHistoryPage;
  g.openEvalWorkbenchPage = openEvalWorkbenchPage;
  g.loadEvalReports = loadEvalReports;
  g.setEvalRunning = setEvalRunning;
  g.evalReportProtocolConnected = evalReportProtocolConnected;
  g.evalReportProtocolSummary = evalReportProtocolSummary;
  g.rememberEvalReport = rememberEvalReport;
  g.runProviderEvalRequest = runProviderEvalRequest;
  g.startEval = startEval;
  g.deleteEvalReport = deleteEvalReport;
  g.toggleProviderEnabled = toggleProviderEnabled;
  g.deleteProvider = deleteProvider;
  g.copyLocalProxyInfo = copyLocalProxyInfo;
  g.navigateToProxyModels = navigateToProxyModels;
  g.navigateToProxyEnhancement = navigateToProxyEnhancement;
})(globalThis);
