// runtime/theme-and-config.js — 主题/风格切换、导航栏图标、接入指引与设置持久化
import { fmtNum, forEachElementAlias, setText, setBar, pctOf, escapeHtml } from '../ui/dom.js';
import { addLog, clearLogs, setLogFilter, openLogViewerModal, closeLogViewerModal, closeLogViewerOnEsc, syncLogViewerControls, onLogViewerLevelChange, setLogViewerLevelPreset, onLogViewerSearchInput, onLogViewerLimitChange, onLogViewerOrderChange, onLogViewerAutoScrollChange, logViewerFilteredEntries, renderLogViewerLine, renderLogViewer, exportLogs, nowTs, renderLogLine, renderLogs, scheduleLogRender } from '../state/logs.js';

// ═══════ THEME ═══════
// data-scheme 决定明暗底盘（CSS 里 248 处组件特化依赖它），data-theme 只决定色板覆盖。
// 三维正交架构：
//   1) data-scheme  明暗底盘（light / dark，由主题自带）
//   2) data-theme   配色方案（决定色板变量）
//   3) data-style   质感风格（soft 轻拟物 / minimal 极简扁平，与配色完全解耦）
const THEME_LIST = [
  { id: 'light', scheme: 'light', label: '工作台浅色', desc: '当前使用工作台浅色', group: 'light' },
  { id: 'claude', scheme: 'light', label: '暖沙 Claude', desc: '当前使用暖沙 Claude', group: 'light' },
  { id: 'minimal', scheme: 'light', label: '极简云白', desc: '当前使用极简云白', group: 'light' },
  { id: 'dark', scheme: 'dark', label: '工作台深色', desc: '当前使用工作台深色', group: 'dark' },
  { id: 'eva', scheme: 'dark', label: '霓虹 EVA', desc: '当前使用霓虹 EVA', group: 'dark' },
  { id: 'ink', scheme: 'dark', label: '极简墨黑', desc: '当前使用极简墨黑', group: 'dark' },
];
const THEME_STORAGE_KEY = 'byok-theme';

// 风格维度：只描述质感语言（圆角/阴影/描边/胶囊化），绝不包含配色
const STYLE_LIST = [
  { id: 'soft', label: '轻拟物', desc: '当前使用轻拟物风格（玻璃质感与层次投影）' },
  { id: 'minimal', label: '极简扁平', desc: '当前使用极简扁平风格（纯净胶囊与细腻描边）' },
];
const STYLE_STORAGE_KEY = 'byok-style';

function themeMeta(id) {
  return THEME_LIST.find(item => item.id === id) || THEME_LIST[0];
}
function currentThemeId() {
  return themeMeta(document.documentElement.getAttribute('data-theme')).id;
}
function syncThemeUI(meta) {
  const desc = document.getElementById('theme-setting-desc');
  if (desc) desc.textContent = meta.desc;
  const topbarBtn = document.getElementById('topbarThemeToggle');
  if (topbarBtn) {
    topbarBtn.title = '切换主题';
    topbarBtn.setAttribute('aria-label', '切换主题');
  }
  document.querySelectorAll('.theme-menu-item, .theme-card').forEach(el => {
    const active = el.getAttribute('data-theme-id') === meta.id;
    el.classList.toggle('is-active', active);
    el.setAttribute('aria-checked', active ? 'true' : 'false');
  });
}
function styleMeta(id) {
  return STYLE_LIST.find(item => item.id === id) || STYLE_LIST[0];
}
function currentStyleId() {
  return styleMeta(document.documentElement.getAttribute('data-style')).id;
}
/**
 * 解析风格偏好：
 * 1) 已存 byok-style → 直接用（老用户沿用自己选过的质感）
 * 2) 其余默认极简扁平（2026-11-01 起；此前默认轻拟物）
 */
function resolveStylePreference() {
  try {
    const saved = localStorage.getItem(STYLE_STORAGE_KEY);
    if (saved) return styleMeta(saved).id;
  } catch (e) { /* localStorage 不可用时按默认走 */ }
  return 'minimal';
}
function syncStyleUI(meta) {
  const desc = document.getElementById('style-setting-desc');
  if (desc) desc.textContent = meta.desc;
  document.querySelectorAll('[data-style-id]').forEach(el => {
    const active = el.getAttribute('data-style-id') === meta.id;
    el.classList.toggle('is-active', active);
    el.setAttribute('aria-checked', active ? 'true' : 'false');
  });
}
function applyStyle(styleId) {
  const meta = styleMeta(styleId);
  document.documentElement.setAttribute('data-style', meta.id);
  syncStyleUI(meta);
}
function setStyle(id) {
  const prev = currentStyleId();
  applyStyle(id);
  try {
    localStorage.setItem(STYLE_STORAGE_KEY, styleMeta(id).id);
  } catch (e) {
    applyStyle(prev);
    addLog('err', '保存风格偏好失败: ' + e);
    if (typeof showCustomAlert === 'function') showCustomAlert(String(e), '保存失败', 'error');
    return;
  }
}
function applyTheme(theme) {
  const meta = themeMeta(theme);
  const root = document.documentElement;
  root.setAttribute('data-theme', meta.id);
  root.setAttribute('data-scheme', meta.scheme);
  root.style.colorScheme = meta.scheme;
  // 风格与配色正交：切配色不得重置风格
  const styleId = root.getAttribute('data-style') || resolveStylePreference();
  applyStyle(styleId);
  try {
    if (!localStorage.getItem(STYLE_STORAGE_KEY)) localStorage.setItem(STYLE_STORAGE_KEY, styleId);
  } catch (e) { /* ignore */ }
  syncThemeUI(meta);
}
function setTheme(id) {
  const prev = currentThemeId();
  applyTheme(id);
  try {
    localStorage.setItem(THEME_STORAGE_KEY, themeMeta(id).id);
  } catch (e) {
    applyTheme(prev);
    addLog('err', '保存主题偏好失败: ' + e);
    if (typeof showCustomAlert === 'function') showCustomAlert(String(e), '保存失败', 'error');
    return;
  }
  closeThemeMenu();
}
function toggleTheme() {
  // 兼容旧入口：在浅色系与深色系之间切换
  setTheme(themeMeta(currentThemeId()).scheme === 'dark' ? 'light' : 'dark');
}
/**
 * 菜单位置修正：默认以主题按钮为轴心居中（CSS translateX(-50%)），
 * 仅当居中出现超窗时，才按最小必要距离平移回来，保证视觉上仍贴近居中。
 */
function positionThemeMenu() {
  const menu = document.getElementById('themeMenu');
  if (!menu || menu.hasAttribute('hidden')) return;
  menu.style.transform = '';
  const rect = menu.getBoundingClientRect();
  const vw = document.documentElement.clientWidth;
  const margin = 12;
  let shift = 0;
  if (rect.right > vw - margin) shift = (vw - margin) - rect.right;
  else if (rect.left < margin) shift = margin - rect.left;
  if (shift) menu.style.transform = `translateX(calc(-50% + ${Math.round(shift)}px))`;
}
function openThemeMenu() {
  const menu = document.getElementById('themeMenu');
  const btn = document.getElementById('topbarThemeToggle');
  if (!menu) return;
  syncThemeUI(themeMeta(currentThemeId()));
  menu.style.transform = '';
  menu.removeAttribute('hidden');
  if (btn) btn.setAttribute('aria-expanded', 'true');
  positionThemeMenu();
}
window.addEventListener('resize', () => {
  const menu = document.getElementById('themeMenu');
  if (menu && !menu.hasAttribute('hidden')) positionThemeMenu();
});
function closeThemeMenu() {
  const menu = document.getElementById('themeMenu');
  const btn = document.getElementById('topbarThemeToggle');
  if (!menu || menu.hasAttribute('hidden')) return;
  menu.setAttribute('hidden', '');
  if (btn) btn.setAttribute('aria-expanded', 'false');
}
function toggleThemeMenu() {
  const menu = document.getElementById('themeMenu');
  if (!menu) return;
  if (menu.hasAttribute('hidden')) openThemeMenu();
  else closeThemeMenu();
}
document.addEventListener('click', (event) => {
  const target = event.target;
  if (target && target.closest && target.closest('.topbar-theme-wrap')) return;
  closeThemeMenu();
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closeThemeMenu();
});

// ═══════ NAV ICONS VISIBILITY（外观设置里的「导航栏图标」开关） ═══════
const NAV_ICONS_STORAGE_KEY = 'byok-show-nav-icons';

function navIconsVisible() {
  // 默认隐藏（2026-11-01 起）：只有显式选过「显示」的用户才渲染顶部标签图标
  try { return localStorage.getItem(NAV_ICONS_STORAGE_KEY) === 'true'; } catch (e) { return false; }
}
function applyNavIconsVisible(visible) {
  if (visible) delete document.documentElement.dataset.navIcons;
  else document.documentElement.dataset.navIcons = 'hidden';
  document.querySelectorAll('[data-nav-icons-toggle]').forEach(el => {
    setConfigToggleElementState(el, visible);
  });
}
function setNavIconsVisible(visible) {
  const prev = navIconsVisible();
  applyNavIconsVisible(visible);
  try {
    localStorage.setItem(NAV_ICONS_STORAGE_KEY, visible ? 'true' : 'false');
  } catch (e) {
    applyNavIconsVisible(prev);
    addLog('err', '保存导航图标偏好失败: ' + e);
  }
}
function toggleNavIcons(el) {
  setNavIconsVisible(!el.classList.contains('on'));
}
function openAppearanceSettings() {
  closeThemeMenu();
  openSettingsModal('appearance');
}
applyNavIconsVisible(navIconsVisible());

// ═══════ ACCESS GUIDE (replaces patch logic) ═══════
async function openCertsDir() {
  if (!invoke) return;
  try { await invoke('open_config_dir', { which: 'certs' }); }
  catch (e) { addLog('err', '打开目录失败: ' + e); }
}
async function openConfigDir() {
  if (!invoke) return;
  try { await invoke('open_config_dir', { which: 'config' }); }
  catch (e) { addLog('err', '打开目录失败: ' + e); }
}
async function generateCerts() {
  if (!invoke) return;
  const status = (typeof _platformEl === 'function' ? _platformEl('cert-status') : document.getElementById('cert-status'));
  try {
    const result = await invoke('generate_certs', { requestId: window.newCertRequestId() });
    if (status) status.textContent = result + '（重启网关后生效）';
    addLog('ok', '证书: ' + result);
  } catch (e) {
    if (status) status.textContent = '生成失败: ' + e;
    addLog('err', '证书生成失败: ' + e);
  }
}

async function runSettingsEnvironmentCheck() {
  const btn = document.getElementById('env-check-btn');
  const summary = document.getElementById('env-check-summary');
  if (btn) btn.disabled = true;
  if (summary) summary.innerHTML = loadingHtml('体检中，正在自动修复可处理的问题…');
  try {
    const result = await runEnvironmentCheck({ target: getTargetIde(), prefix: '手动体检', renderTo: 'env-check-results' });
    if (summary) {
      summary.textContent = result.errors.length
        ? `体检未通过：${result.errors.length} 个错误，${result.warnings.length} 个提示`
        : `体检通过：${result.warnings.length} 个提示`;
    }
    if (result.errors.length) {
      showCustomAlert('环境体检未通过:\n\n• ' + result.errors.map(i => i.message || String(i)).join('\n• '), '环境体检', 'error');
    }
  } catch (e) {
    if (summary) summary.textContent = '体检失败: ' + e;
    addLog('err', '手动体检失败: ' + e);
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function detectIdePath() {
  if (!invoke) return;
  const input = (typeof _platformEl === 'function' ? _platformEl('idePath') : document.getElementById('idePath'));
  const status = (typeof _platformEl === 'function' ? _platformEl('ide-path-status') : document.getElementById('ide-path-status'));
  try {
    const target = getTargetIde();
    const path = await invoke('detect_ide_path', { target });
    if (path) {
      if (input) input.value = path;
      if (status) status.textContent = '已自动定位 ✓';
    } else {
      if (input) { input.value = ''; input.placeholder = '未自动定位，请手动指定 IDE 可执行文件'; }
      if (status) status.textContent = '自动探测失败，请手动指定 IDE 可执行文件后保存';
    }
  } catch (e) {
    if (status) status.textContent = '探测失败: ' + e;
  }
}

async function saveIdePath() {
  if (!invoke) return;
  const input = (typeof _platformEl === 'function' ? _platformEl('idePath') : document.getElementById('idePath'));
  const status = (typeof _platformEl === 'function' ? _platformEl('ide-path-status') : document.getElementById('ide-path-status'));
  const path = input ? input.value.trim() : '';
  if (!path) { if (status) status.textContent = '请先填写 IDE 可执行文件路径'; return; }
  try {
    await invoke('set_ide_path', { path });
    if (status) status.textContent = '已保存路径 ✓（下次启动网关生效）';
    addLog('ok', 'IDE 路径已设置: ' + path);
  } catch (e) {
    if (status) status.textContent = '保存失败: ' + e;
    addLog('err', 'IDE 路径保存失败: ' + e);
  }
}

// ═══════ CONFIG PERSISTENCE ═══════
async function loadAndFillConfig() {
  if (!invoke) return {};
  try {
    const values = await invoke('load_config');
    document.querySelectorAll('[data-config-key]').forEach(el => {
      const k = el.getAttribute('data-config-key');
      if (k in values) el.value = values[k];
      el.dataset.persistedValue = el.value;
    });
    applyToggleStates(values);
    await ensureLocalProxyConfig(values);
    const targetSelect = document.getElementById('targetIde');
    if (targetSelect) targetSelect.dataset.persistedValue = targetSelect.value;
    if (window.ByokI18n) {
      window.ByokI18n.initFromConfig(values);
      window.ByokI18n.bindLanguageControls();
    }
    await syncAutostartState();
    return values;
  } catch (e) { return {}; }
}

async function saveConfigField(key, value) {
  if (!invoke) {
    if (typeof showCustomAlert === 'function') showCustomAlert('当前环境缺少 Tauri invoke，无法保存配置。', '保存失败', 'error');
    return false;
  }
  try {
    const current = await invoke('load_config');
    current[key] = value;
    await invoke('save_config', { values: current });
    return true;
  } catch (e) {
    addLog('err', '保存配置失败: ' + e);
    if (typeof showCustomAlert === 'function') showCustomAlert(String(e), '保存配置失败', 'error');
    return false;
  }
}

document.querySelectorAll('[data-config-key]').forEach(el => {
  el.addEventListener('change', async () => {
    const previous = el.dataset.persistedValue ?? el.defaultValue ?? '';
    const ok = await saveConfigField(el.getAttribute('data-config-key'), el.value);
    if (ok) {
      el.dataset.persistedValue = el.value;
    } else {
      el.value = previous;
    }
  });
});

// ═══════ TOGGLE SWITCHES (persisted as config) ═══════
document.querySelectorAll('[data-config-toggle]').forEach(el => {
  el.addEventListener('click', async () => {
    const key = el.getAttribute('data-config-toggle');
    const previous = el.classList.contains('on');
    const next = !previous;
    setConfigToggleState(key, next);
    const ok = await saveConfigField(key, next ? 'true' : 'false');
    if (!ok) setConfigToggleState(key, previous);
  });
});

document.querySelectorAll('[data-ide-restart-toggle]').forEach(el => {
  el.addEventListener('click', () => {
    const previous = el.classList.contains('on');
    const next = !previous;
    setConfigToggleElementState(el, next);
    const ok = setAutoRestartIdeAfterSwitch(next);
    if (!ok) setConfigToggleElementState(el, previous);
  });
});

document.querySelectorAll('[data-autostart]').forEach(el => {
  el.addEventListener('click', async () => {
    const previous = el.classList.contains('on');
    const enabled = !previous;
    setAutostartToggleState(enabled);
    if (invoke) {
      try { await invoke('set_autostart', { enabled }); addLog('ok', enabled ? '已设置开机自启' : '已取消开机自启'); }
      catch (e) {
        setAutostartToggleState(previous);
        addLog('err', '自启设置失败: ' + e);
        if (typeof showCustomAlert === 'function') showCustomAlert(String(e), '自启设置失败', 'error');
      }
    } else {
      setAutostartToggleState(previous);
    }
  });
});

async function syncAutostartState() {
  if (!invoke) return;
  try {
    const enabled = await invoke('get_autostart');
    setAutostartToggleState(!!enabled);
  } catch (e) {
    addLog('warn', '读取开机自启状态失败: ' + e);
  }
}

function setAutostartToggleState(enabled) {
  document.querySelectorAll('[data-autostart]').forEach(el => {
    el.classList.toggle('on', !!enabled);
    el.setAttribute('aria-pressed', enabled ? 'true' : 'false');
    el.setAttribute('aria-checked', enabled ? 'true' : 'false');
  });
}

function applyToggleStates(config) {
  document.querySelectorAll('[data-config-toggle]').forEach(el => {
    const key = el.getAttribute('data-config-toggle');
    // AUTO_START_PROXY 默认为 true（未配置时也开启）
    if (key === 'AUTO_START_PROXY') {
      setConfigToggleElementState(el, config[key] !== 'false');
    } else {
      if (config[key] === 'true') setConfigToggleElementState(el, true);
      else if (config[key] === 'false') setConfigToggleElementState(el, false);
    }
  });
}

function setConfigToggleElementState(el, enabled) {
  el.classList.toggle('on', !!enabled);
  el.setAttribute('aria-pressed', enabled ? 'true' : 'false');
  el.setAttribute('aria-checked', enabled ? 'true' : 'false');
}

function setConfigToggleState(key, enabled) {
  document.querySelectorAll(`[data-config-toggle="${key}"]`).forEach(el => {
    setConfigToggleElementState(el, enabled);
  });
}

// ---- P3 globalThis mirror ----
(function mirrorFns(g) {
  g.currentThemeId = currentThemeId;
  g.currentStyleId = currentStyleId;
  g.resolveStylePreference = resolveStylePreference;
  g.applyStyle = applyStyle;
  g.setStyle = setStyle;
  g.applyTheme = applyTheme;
  g.setTheme = setTheme;
  g.toggleTheme = toggleTheme;
  g.closeThemeMenu = closeThemeMenu;
  g.toggleThemeMenu = toggleThemeMenu;
  g.applyNavIconsVisible = applyNavIconsVisible;
  g.setNavIconsVisible = setNavIconsVisible;
  g.toggleNavIcons = toggleNavIcons;
  g.openAppearanceSettings = openAppearanceSettings;
  g.openCertsDir = openCertsDir;
  g.openConfigDir = openConfigDir;
  g.generateCerts = generateCerts;
  g.runSettingsEnvironmentCheck = runSettingsEnvironmentCheck;
  g.detectIdePath = detectIdePath;
  g.saveIdePath = saveIdePath;
  g.loadAndFillConfig = loadAndFillConfig;
  g.saveConfigField = saveConfigField;
  g.syncAutostartState = syncAutostartState;
  g.setAutostartToggleState = setAutostartToggleState;
  g.applyToggleStates = applyToggleStates;
  g.setConfigToggleElementState = setConfigToggleElementState;
  g.setConfigToggleState = setConfigToggleState;
  g.THEME_LIST = THEME_LIST;
  g.STYLE_LIST = STYLE_LIST;
})(globalThis);
