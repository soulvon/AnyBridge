// platforms/cursor_modals.js — split from 55-platforms.js
// ═══════ CURSOR 接入设置模态弹窗 ═══════

function openCursorSettingsModal(initialTab = 'diag') {
  const modal = document.getElementById('cursorSettingsModal');
  if (!modal) return;
  switchCursorSettingsTab(initialTab);
  syncCursorSettingsModalData();
  modal.classList.add('active');
  document.addEventListener('keydown', closeCursorSettingsModalOnEsc);
}

function closeCursorSettingsModal() {
  const modal = document.getElementById('cursorSettingsModal');
  if (modal) modal.classList.remove('active');
  document.removeEventListener('keydown', closeCursorSettingsModalOnEsc);
}

function closeCursorSettingsModalOnEsc(event) {
  if (event.key === 'Escape') closeCursorSettingsModal();
}

function switchCursorSettingsTab(tabName) {
  const tabs = ['diag', 'core', 'cert', 'advanced'];
  tabs.forEach(t => {
    const btn = document.getElementById(`cursor-settings-nav-${t}`);
    const panel = document.getElementById(`cursor-settings-panel-${t}`);
    const isTarget = t === tabName;
    if (btn) btn.classList.toggle('active', isTarget);
    if (panel) {
      panel.classList.toggle('active', isTarget);
      panel.style.display = isTarget ? 'block' : 'none';
    }
  });
}

async function syncCursorSettingsModalData() {
  const status = globalThis._cursorCachedStatus;
  const running = !!status?.running;
  const certReady = !!status?.certificateReady;
  const modelCount = Array.isArray(globalThis._cursorModelsList) ? globalThis._cursorModelsList.length : (status?.configuredModels || 0);

  // 1. 状态诊断标签与说明
  const coreTag = document.getElementById('cursor-diag-core-status-tag');
  const coreDesc = document.getElementById('cursor-diag-core-desc');
  if (coreTag) {
    coreTag.textContent = running ? '运行中 (正常)' : '未运行';
    coreTag.className = `tag ${running ? 'success' : 'secondary'}`;
  }
  if (coreDesc) {
    coreDesc.textContent = running
      ? `Core 进程活跃，控制端口 :${status?.controlPort || 17650} 响应正常`
      : 'Core 进程未启动，点击主界面「一键接入」即可自动拉起';
  }

  const certTag = document.getElementById('cursor-diag-cert-status-tag');
  const certDesc = document.getElementById('cursor-diag-cert-desc');
  if (certTag) {
    certTag.textContent = certReady ? '已受信 (就绪)' : '未安装/未信任';
    certTag.className = `tag ${certReady ? 'success' : 'warn'}`;
  }
  if (certDesc && status?.certificateMessage) {
    certDesc.textContent = status.certificateMessage;
  }

  const countTag = document.getElementById('cursor-diag-model-count-tag');
  if (countTag) {
    countTag.textContent = `${modelCount} 个`;
  }

  // 2. 环境与端口
  const portInput = document.getElementById('cursorCorePortInput');
  if (portInput) {
    portInput.value = status?.controlPort || 17650;
  }

  // 3. IDE 安装路径
  const pathInput = document.getElementById('cursorIdePathInput');
  if (pathInput && !pathInput.value) {
    try {
      if (invoke) {
        const p = await invoke('detect_ide_path', { target: 'cursor' });
        if (p) pathInput.value = p;
      }
    } catch (_) {}
  }

  // 4. 供应商标签展示方式
  cursorUpdateTagStyleSelects(globalThis._cursorProviderTagStyle);
}

globalThis._cursorTagMainMode = 'badge'; // 'text' | 'badge' | 'none'
globalThis._cursorTextPosition = 'prefix'; // 'prefix' | 'suffix'

function cursorUpdateTagStyleSelects(style) {
  globalThis._cursorProviderTagStyle = style || 'badge';
  if (globalThis._cursorProviderTagStyle === 'prefix' || globalThis._cursorProviderTagStyle === 'suffix') {
    globalThis._cursorTagMainMode = 'text';
    globalThis._cursorTextPosition = globalThis._cursorProviderTagStyle;
  } else if (globalThis._cursorProviderTagStyle === 'none') {
    globalThis._cursorTagMainMode = 'none';
  } else {
    globalThis._cursorTagMainMode = 'badge';
  }

  const sel = document.getElementById('cursorSettingsTagStyleSelect');
  if (sel && sel.value !== globalThis._cursorProviderTagStyle) sel.value = globalThis._cursorProviderTagStyle;

  cursorRenderModalState();
}

function cursorRenderModalState() {
  // 1. 更新左栏 3 个单选卡片
  const radios = document.querySelectorAll('input[name="cursorTagMainModeRadio"]');
  radios.forEach(r => {
    r.checked = r.value === globalThis._cursorTagMainMode;
    const parent = r.closest('.cursor-tag-style-option');
    if (parent) {
      if (r.checked) {
        parent.style.borderColor = 'var(--accent)';
        parent.style.background = 'rgba(37, 99, 235, 0.05)';
      } else {
        parent.style.borderColor = 'var(--border)';
        parent.style.background = 'var(--bg-card)';
      }
    }
  });

  // 2. 右侧配置区按主模式显隐
  const textCustomPanel = document.getElementById('cursorTextCustomizationPanel');
  const customDisabledTip = document.getElementById('cursorTextCustomDisabledTip');
  const isTextMode = globalThis._cursorTagMainMode === 'text';

  if (textCustomPanel) textCustomPanel.style.display = isTextMode ? 'flex' : 'none';
  if (customDisabledTip) {
    customDisabledTip.style.display = isTextMode ? 'none' : 'block';
    const tipTitle = document.getElementById('cursorTextCustomDisabledTitle');
    const tipDesc = document.getElementById('cursorTextCustomDisabledDesc');
    if (globalThis._cursorTagMainMode === 'badge') {
      if (tipTitle) tipTitle.textContent = 'Cursor 官方原生徽章';
      if (tipDesc) tipDesc.textContent = '直接使用 Cursor 原生蓝色 Badge 标签，打钩在徽章最右侧，无需额外配置符号。';
    } else if (globalThis._cursorTagMainMode === 'none') {
      if (tipTitle) tipTitle.textContent = '纯净极简形式';
      if (tipDesc) tipDesc.textContent = '不显示任何供应商标签或前缀，模型名称保持极致清爽整洁。';
    }
  }

  // 3. 更新位置分段控件高亮 (现代白底卡片滑块质感)
  const prefixBtn = document.getElementById('cursorPosPrefixBtn');
  const suffixBtn = document.getElementById('cursorPosSuffixBtn');
  if (prefixBtn && suffixBtn) {
    const isPrefix = globalThis._cursorTextPosition === 'prefix';
    if (isPrefix) {
      prefixBtn.style.background = 'var(--bg-card)';
      prefixBtn.style.color = 'var(--text-primary)';
      prefixBtn.style.boxShadow = '0 1px 3px rgba(0,0,0,0.08)';
      prefixBtn.style.fontWeight = '650';

      suffixBtn.style.background = 'transparent';
      suffixBtn.style.color = 'var(--text-secondary)';
      suffixBtn.style.boxShadow = 'none';
      suffixBtn.style.fontWeight = '500';
    } else {
      suffixBtn.style.background = 'var(--bg-card)';
      suffixBtn.style.color = 'var(--text-primary)';
      suffixBtn.style.boxShadow = '0 1px 3px rgba(0,0,0,0.08)';
      suffixBtn.style.fontWeight = '650';

      prefixBtn.style.background = 'transparent';
      prefixBtn.style.color = 'var(--text-secondary)';
      prefixBtn.style.boxShadow = 'none';
      prefixBtn.style.fontWeight = '500';
    }
  }

  // 4. 更新括号与实时预览
  cursorSyncBracketUI();
  cursorUpdateSimulationPreview();
}

function cursorUpdateSimulationPreview() {
  const modelNameEl = document.getElementById('cursorSimulationModelName');
  const badgeEl = document.getElementById('cursorSimulationBadge');
  if (!modelNameEl || !badgeEl) return;

  if (globalThis._cursorTagMainMode === 'text') {
    badgeEl.style.display = 'none';
    const left = globalThis._cursorProviderBracketLeft ?? '[';
    const right = globalThis._cursorProviderBracketRight ?? ']';
    const tag = `${left}CPA${right}`;
    if (globalThis._cursorTextPosition === 'prefix') {
      modelNameEl.textContent = `${tag} Gemini 3.8 Flash`;
    } else {
      modelNameEl.textContent = `Gemini 3.8 Flash ${tag}`;
    }
  } else if (globalThis._cursorTagMainMode === 'badge') {
    modelNameEl.textContent = 'Gemini 3.8 Flash';
    badgeEl.style.display = 'inline-block';
    badgeEl.textContent = 'CPA';
  } else {
    modelNameEl.textContent = 'Gemini 3.8 Flash';
    badgeEl.style.display = 'none';
  }
}

function cursorSyncBracketUI() {
  const left = globalThis._cursorProviderBracketLeft ?? '[';
  const right = globalThis._cursorProviderBracketRight ?? ']';

  const leftInput = document.getElementById('cursorBracketLeftInput');
  const rightInput = document.getElementById('cursorBracketRightInput');
  const customInputs = document.getElementById('cursorTagBracketCustomInputs');
  if (leftInput && leftInput.value !== left) leftInput.value = left;
  if (rightInput && rightInput.value !== right) rightInput.value = right;

  let matched = 'custom';
  if (left === '[' && right === ']') matched = '[]';
  else if (left === '(' && right === ')') matched = '()';
  else if (left === '【' && right === '】') matched = '【】';
  else if (left === '{' && right === '}') matched = '{}';
  else if (left === '' && right === '') matched = 'none';

  const btns = document.querySelectorAll('#cursorBracketPresetButtons .cursor-bracket-btn');
  btns.forEach(b => {
    const p = b.getAttribute('data-bracket');
    const active = p === matched;
    if (active) {
      b.style.background = 'rgba(37, 99, 235, 0.08)';
      b.style.color = 'var(--accent)';
      b.style.borderColor = 'var(--accent)';
      b.style.boxShadow = '0 0 0 1px rgba(37, 99, 235, 0.2)';
      b.style.fontWeight = '650';
    } else {
      b.style.background = 'var(--bg-card)';
      b.style.color = 'var(--text-secondary)';
      b.style.borderColor = 'var(--border)';
      b.style.boxShadow = 'none';
      b.style.fontWeight = '500';
    }
  });

  if (customInputs) {
    customInputs.style.display = matched === 'custom' ? 'flex' : 'none';
  }
}

function selectCursorBracketPreset(preset) {
  if (preset === '[]') {
    globalThis._cursorProviderBracketLeft = '[';
    globalThis._cursorProviderBracketRight = ']';
  } else if (preset === '()') {
    globalThis._cursorProviderBracketLeft = '(';
    globalThis._cursorProviderBracketRight = ')';
  } else if (preset === '【】') {
    globalThis._cursorProviderBracketLeft = '【';
    globalThis._cursorProviderBracketRight = '】';
  } else if (preset === '{}') {
    globalThis._cursorProviderBracketLeft = '{';
    globalThis._cursorProviderBracketRight = '}';
  } else if (preset === 'none') {
    globalThis._cursorProviderBracketLeft = '';
    globalThis._cursorProviderBracketRight = '';
  }
  cursorSyncBracketUI();
  cursorUpdateSimulationPreview();
}

function openCursorTagStyleModal() {
  const modal = document.getElementById('cursorTagStyleModal');
  if (!modal) return;
  cursorUpdateTagStyleSelects(globalThis._cursorProviderTagStyle);
  modal.classList.add('active');
  document.addEventListener('keydown', closeCursorTagStyleModalOnEsc);

  // 绑定左栏 3 个主卡片点击
  const options = modal.querySelectorAll('.cursor-tag-style-option');
  options.forEach(opt => {
    opt.onclick = () => {
      const radio = opt.querySelector('input[type="radio"]');
      if (radio) {
        radio.checked = true;
        globalThis._cursorTagMainMode = radio.value;
        cursorRenderModalState();
      }
    };
  });

  // 绑定位置按钮：前置 / 后置
  const prefixBtn = document.getElementById('cursorPosPrefixBtn');
  const suffixBtn = document.getElementById('cursorPosSuffixBtn');
  if (prefixBtn) {
    prefixBtn.onclick = (e) => {
      e.stopPropagation();
      globalThis._cursorTextPosition = 'prefix';
      cursorRenderModalState();
    };
  }
  if (suffixBtn) {
    suffixBtn.onclick = (e) => {
      e.stopPropagation();
      globalThis._cursorTextPosition = 'suffix';
      cursorRenderModalState();
    };
  }

  // 绑定预设括号按钮点击
  const presetBtns = modal.querySelectorAll('#cursorBracketPresetButtons .cursor-bracket-btn');
  presetBtns.forEach(btn => {
    btn.onclick = (e) => {
      e.stopPropagation();
      const p = btn.getAttribute('data-bracket');
      if (p === 'custom') {
        const customInputs = document.getElementById('cursorTagBracketCustomInputs');
        if (customInputs) customInputs.style.display = 'flex';
        btn.style.background = 'rgba(37, 99, 235, 0.08)';
        btn.style.color = 'var(--accent)';
        btn.style.borderColor = 'var(--accent)';
        btn.style.boxShadow = '0 0 0 1px rgba(37, 99, 235, 0.2)';
        btn.style.fontWeight = '650';
        presetBtns.forEach(other => {
          if (other !== btn) {
            other.style.background = 'var(--bg-card)';
            other.style.color = 'var(--text-secondary)';
            other.style.borderColor = 'var(--border)';
            other.style.boxShadow = 'none';
            other.style.fontWeight = '500';
          }
        });
        const leftInput = document.getElementById('cursorBracketLeftInput');
        if (leftInput) leftInput.focus();
      } else {
        selectCursorBracketPreset(p);
      }
    };
  });

  // 绑定自定义左右符号输入实时响应
  const leftInput = document.getElementById('cursorBracketLeftInput');
  const rightInput = document.getElementById('cursorBracketRightInput');
  if (leftInput) {
    leftInput.oninput = () => {
      globalThis._cursorProviderBracketLeft = leftInput.value;
      cursorUpdateSimulationPreview();
    };
  }
  if (rightInput) {
    rightInput.oninput = () => {
      globalThis._cursorProviderBracketRight = rightInput.value;
      cursorUpdateSimulationPreview();
    };
  }
}

function closeCursorTagStyleModal() {
  const modal = document.getElementById('cursorTagStyleModal');
  if (modal) modal.classList.remove('active');
  document.removeEventListener('keydown', closeCursorTagStyleModalOnEsc);
}

function closeCursorTagStyleModalOnEsc(event) {
  if (event.key === 'Escape') closeCursorTagStyleModal();
}

async function saveCursorTagStyleModal() {
  let targetStyle = 'badge';
  if (globalThis._cursorTagMainMode === 'text') {
    targetStyle = globalThis._cursorTextPosition; // 'prefix' 或 'suffix'
  } else if (globalThis._cursorTagMainMode === 'none') {
    targetStyle = 'none';
  } else {
    targetStyle = 'badge';
  }

  const leftInput = document.getElementById('cursorBracketLeftInput');
  const rightInput = document.getElementById('cursorBracketRightInput');
  if (leftInput) globalThis._cursorProviderBracketLeft = leftInput.value;
  if (rightInput) globalThis._cursorProviderBracketRight = rightInput.value;

  closeCursorTagStyleModal();
  await cursorChangeProviderTagStyle(targetStyle, globalThis._cursorProviderBracketLeft, globalThis._cursorProviderBracketRight);
}

async function cursorChangeProviderTagStyle(style, bracketLeft, bracketRight) {
  const nextStyle = String(style || 'badge').trim().toLowerCase();
  const bl = bracketLeft ?? globalThis._cursorProviderBracketLeft;
  const br = bracketRight ?? globalThis._cursorProviderBracketRight;
  globalThis._cursorProviderTagStyle = nextStyle;
  globalThis._cursorProviderBracketLeft = bl;
  globalThis._cursorProviderBracketRight = br;
  cursorUpdateTagStyleSelects(nextStyle);
  if (!invoke) return;

  try {
    cursorSetBusy(true);
    await invoke('cursor_set_provider_tag_style', {
      style: nextStyle,
      bracketLeft: bl,
      bracketRight: br,
    });

    const labelMap = {
      prefix: '前缀形式',
      suffix: '后缀形式',
      badge: '徽章形式',
      none: '纯净形式',
    };
    const styleLabel = labelMap[nextStyle] || nextStyle;
    showCustomAlert(`已将 Cursor 供应商标签展示方式切换为「${styleLabel}」，已自动同步至 Cursor。`, '设置已保存', 'success');
  } catch (err) {
    console.error('[cursor] set provider tag style error:', err);
    showCustomAlert(`保存展示方式失败: ${err?.message || err}`, '保存失败', 'error');
  } finally {
    cursorSetBusy(false);
  }
}

function onCursorTagStyleChange(event) {
  const target = event?.target;
  if (target) {
    cursorChangeProviderTagStyle(target.value);
  }
}

async function cursorRefreshConsoleAction() {
  await cursorRefreshConsole();
  await syncCursorSettingsModalData();
  showCustomAlert('Cursor 状态数据已最新刷新。', '刷新成功', 'success');
}

async function detectCursorIdePath() {
  const input = document.getElementById('cursorIdePathInput');
  const statusEl = document.getElementById('cursor-ide-path-status');
  if (!invoke) return;
  try {
    const path = await invoke('detect_ide_path', { target: 'cursor' });
    if (path) {
      if (input) input.value = path;
      if (statusEl) statusEl.textContent = '已自动定位 Cursor 可执行文件 ✓';
    } else {
      if (input) input.placeholder = '自动探测失败，请手动指定可执行文件绝对路径';
      if (statusEl) statusEl.textContent = '未探测到默认安装目录或运行中进程，请手动指定';
    }
  } catch (e) {
    if (statusEl) statusEl.textContent = '探测失败: ' + e;
  }
}

async function saveCursorIdePath() {
  const input = document.getElementById('cursorIdePathInput');
  const statusEl = document.getElementById('cursor-ide-path-status');
  const path = input ? input.value.trim() : '';
  if (!path) {
    showCustomAlert('请先输入或探测 Cursor 安装路径。', '路径为空', 'warn');
    return;
  }
  try {
    if (invoke) {
      await invoke('set_ide_path', { path });
      if (statusEl) statusEl.textContent = '已成功保存 Cursor 路径 ✓';
      showCustomAlert('Cursor 路径已保存。', '保存成功', 'success');
    }
  } catch (e) {
    if (statusEl) statusEl.textContent = '保存失败: ' + e;
    showCustomAlert(String(e), '保存失败', 'error');
  }
}

async function saveCursorCorePort() {
  const portInput = document.getElementById('cursorCorePortInput');
  const val = portInput ? parseInt(portInput.value.trim(), 10) : 17650;
  if (!val || val < 1024 || val > 65535) {
    showCustomAlert('端口号必须在 1024 ~ 65535 范围内。', '端口无效', 'warn');
    return;
  }
  try {
    if (invoke) {
      const current = (await invoke('load_config')) || {};
      current.CURSOR_CORE_PORT = String(val);
      await invoke('save_config', { values: current });
      showCustomAlert(`Cursor Core 端口已配置为 ${val}。重启 Core 后生效。`, '保存成功', 'success');
    }
  } catch (e) {
    showCustomAlert('保存端口失败: ' + e, '保存失败', 'error');
  }
}

// ---- P3 globalThis mirror ----
(function mirrorFns(g) {
  g.openCursorSettingsModal = openCursorSettingsModal;
  g.closeCursorSettingsModal = closeCursorSettingsModal;
  g.closeCursorSettingsModalOnEsc = closeCursorSettingsModalOnEsc;
  g.switchCursorSettingsTab = switchCursorSettingsTab;
  g.syncCursorSettingsModalData = syncCursorSettingsModalData;
  g.cursorUpdateTagStyleSelects = cursorUpdateTagStyleSelects;
  g.cursorRenderModalState = cursorRenderModalState;
  g.cursorUpdateSimulationPreview = cursorUpdateSimulationPreview;
  g.cursorSyncBracketUI = cursorSyncBracketUI;
  g.selectCursorBracketPreset = selectCursorBracketPreset;
  g.openCursorTagStyleModal = openCursorTagStyleModal;
  g.closeCursorTagStyleModal = closeCursorTagStyleModal;
  g.closeCursorTagStyleModalOnEsc = closeCursorTagStyleModalOnEsc;
  g.saveCursorTagStyleModal = saveCursorTagStyleModal;
  g.cursorChangeProviderTagStyle = cursorChangeProviderTagStyle;
  g.onCursorTagStyleChange = onCursorTagStyleChange;
  g.cursorRefreshConsoleAction = cursorRefreshConsoleAction;
  g.detectCursorIdePath = detectCursorIdePath;
  g.saveCursorIdePath = saveCursorIdePath;
  g.saveCursorCorePort = saveCursorCorePort;
})(globalThis);
