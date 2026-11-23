// platforms/hero_and_agents.js — split from 55-platforms.js
// ═══════ Hero 版本行（借鉴 magpie：版本探测 + 更新检查 + 一键更新） ═══════

globalThis._heroVersionBusy = {};

/**
 * 渲染平台 Hero 卡的版本行。
 * 四种状态：未安装 / 版本未知 / 已是最新 / 可更新（带一键更新按钮）。
 * check_platform_update 后端自带缓存（版本 10 分钟、latest 6 小时），
 * 重复调用代价低。
 */
async function renderHeroVersion(platformId, elId) {
  const el = document.getElementById(elId);
  if (!el || _heroVersionBusy[platformId]) return;
  if (typeof invoke !== 'function' && !(typeof bindTauriBridge === 'function' && bindTauriBridge())) return;
  if (el.dataset.versionTarget && el.dataset.versionTarget !== platformId) {
    el.innerHTML = '';
  }
  _heroVersionBusy[platformId] = true;
  // 请求序号：共用同一版本行元素时（windsurf/devin/cursor 共页），
  // 只有**最后一次发起**的请求结果可以落盘。比 platformId 比较更严格
  // （同平台连续请求也不会互相覆盖），且不依赖 rail DOM 状态。
  const seq = String(Number(el.dataset.versionSeq || 0) + 1);
  el.dataset.versionSeq = seq;
  el.dataset.versionTarget = platformId;
  try {
    // 15 秒超时兜底：注册表/子进程异常挂起时不再停留在「检测中」
    const info = await Promise.race([
      invoke('check_platform_update', { platform: platformId }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('version probe timeout')), 15000)),
    ]);
    if (!el.isConnected) return;
    if (el.dataset.versionSeq !== seq) return; // 已有更新的请求，丢弃本次结果
    if (el.dataset.versionTarget !== platformId) return;
    // 静默策略：有版本才展示；版本未知/探测失败留空不打扰。
    // 按钮能力位分两类：「安装/更新」npm 平台看 can_auto_update（npm 可用 +
    // 全局目录免提权可写）；官方自更新平台（grok/hermes，has_self_update）
    // 只要有 update 命令就给按钮，不看 npm 能力位（npm_package 为 None 时
    // can_auto_update 恒 false，见下方两处使用点）。
    if (!info || !info.current_version) {
      if (info && !info.installed) {
        el.innerHTML = info.can_auto_update
          ? '<button type="button" class="version-install-btn" data-action="updatePlatformAgentAction" data-arg="' +
            platformId +
            '">安装</button>'
          : '<span class="version-state muted">未安装</span>';
      } else {
        el.innerHTML = '';
      }
      return;
    }
    if (info.has_update && info.latest_version) {
      // 自更新平台（grok update 等官方命令）不依赖 npm 能力位——
      // npm_package 为 None 时 can_auto_update 恒 false，会把 grok 的
      // 「更新」按钮吞掉（实测 v1.0.30 → v1.0.70 只显示箭头无按钮）
      const canShowUpdate = info.can_auto_update || info.has_self_update;
      const updateBtn = canShowUpdate
        ? '<button type="button" class="version-update-btn" data-action="updatePlatformAgentAction" data-arg="' +
          platformId +
          '">更新</button>'
        : '';
      el.innerHTML =
        '<span class="version-num">v' + info.current_version + '</span>' +
        '<span class="version-arrow">→</span>' +
        '<span class="version-num latest">v' + info.latest_version + '</span>' +
        updateBtn;
    } else {
      // 无 latest 数据：
      // - 有官方自更新命令（grok/hermes）→ 给「更新」按钮（命令会自行检查）
      // - 否则（GUI 客户端无 npm 源，如已停更的 Windsurf）→ 只显示版本号
      // 只有「拿不到 latest」时才给自更新入口（命令自己会检查）；
      // 有 latest 且已是最新 → 不加按钮，否则更新完按钮还挂着，像没生效
      const selfUpdateBtn =
        info.has_self_update && !info.latest_version
          ? '<button type="button" class="version-update-btn" data-action="updatePlatformAgentAction" data-arg="' +
            platformId +
            '">更新</button>'
          : '';
      el.innerHTML = '<span class="version-num">v' + info.current_version + '</span>' + selfUpdateBtn;
    }
  } catch (e) {
    // 显式留痕：invoke 失败/超时时可在日志面板看到原因，
    // 不再静默清空（静默会让人误以为「版本一样」）
    if (typeof addLog === 'function') {
      addLog('warn', `版本探测失败（${platformId}）: ${String(e?.message || e)}`);
    }
    // 静默：失败不占位，只留日志
    if (el.dataset.versionSeq === seq) {
      el.innerHTML = '';
    }
  } finally {
    delete _heroVersionBusy[platformId];
  }
}

/**
 * 安装引导（magpie 克制原则：不代跑安装，只复制可执行命令）。
 * CLI 平台给 npm install -g <pkg>；GUI 客户端给官方下载页。
 */


/**
 * 一键更新平台 CLI（走官方 npm 命令 + 更新后验证，后端 magpie 模式）。
 */
globalThis._updateBusy = {};

async function updatePlatformAgentAction(platform) {
  if (!invoke && !(typeof bindTauriBridge === 'function' && bindTauriBridge())) {
    showCustomAlert('Tauri 通道未就绪，请重启 AnyBridge 后重试。', '更新失败', 'error');
    return;
  }
  // 同平台在途守卫：连点/版本行重渲后再次触发，都不该让两次安装并发跑
  if (_updateBusy[platform]) return;
  _updateBusy[platform] = true;
  // 即时反馈：npm install -g 需要十几到几十秒，期间必须让用户看到「在跑」，
  // 否则点了没反应（实测用户误判为按钮失效）。
  const btn = document.querySelector(
    '[data-action="updatePlatformAgentAction"][data-arg="' + platform + '"]'
  );
  const originalLabel = btn ? btn.textContent : '';
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = loadingHtml(originalLabel === '安装' ? '安装中…' : '更新中…');
  }
  if (typeof showBottomToast === 'function') {
    showBottomToast('正在安装…', 'info', { duration: 3000 });
  }
  if (typeof addLog === 'function') addLog('info', '开始更新 ' + platform + ' …');
  try {
    const info = await invoke('update_platform_agent', { platform });
    // 如实呈现硬校验结论：升上去了 / 执行了但版本没变 / 校验未过已回滚
    const from = info.updated_from ? 'v' + info.updated_from : null;
    const to = info.current_version ? 'v' + info.current_version : null;
    let msg;
    if (info.outcome === 'rolled_back') {
      msg = '更新后校验未通过，已回滚到 ' + (to || '原版本');
    } else if (info.outcome === 'upgraded' && from && to) {
      msg = '已完成 ' + from + ' → ' + to;
    } else {
      msg = '更新已执行，当前仍是 ' + (to || '未知版本') + '（官方渠道可能尚未推送）';
    }
    if (typeof addLog === 'function') addLog('ok', msg);
    const toastType = info.outcome === 'rolled_back' ? 'warn' : 'success';
    if (typeof showBottomToast === 'function') showBottomToast(msg, toastType);
  } catch (e) {
    const message = String(e?.message || e);
    if (typeof addLog === 'function') addLog('err', platform + ' 更新失败: ' + message);
    if (typeof showCustomAlert === 'function') showCustomAlert(message, platform + ' 更新失败', 'error');
  } finally {
    _updateBusy[platform] = false;
    // 恢复按钮（版本行重渲后新按钮会是正确文案；重渲失败时至少不让按钮卡死）
    if (btn && btn.isConnected) {
      btn.disabled = false;
      btn.textContent = originalLabel;
    }
    const lineEl = btn ? btn.closest('.platform-version-line') : null;
    if (lineEl && lineEl.id) renderHeroVersion(platform, lineEl.id);
  }
}


// ─── 声明式 agent：rail 追加 + 通用页渲染 ───
globalThis._agentRegistryCache = { at: 0, list: [] };

async function loadAgentRegistry(force = false) {
  const now = Date.now();
  if (!force && _agentRegistryCache.list.length && now - _agentRegistryCache.at < 30000) {
    return _agentRegistryCache.list;
  }
  if (!invoke && !(typeof bindTauriBridge === 'function' && bindTauriBridge())) return [];
  try {
    const list = (await invoke('get_agent_registry')) || [];
    _agentRegistryCache.list = list;
    _agentRegistryCache.at = now;
    return list;
  } catch (e) {
    if (typeof addLog === 'function') addLog('warn', '读取 Agent 声明表失败: ' + String(e?.message || e));
    return [];
  }
}

function _agentInitial(name) {
  const t = String(name || '?').trim();
  return t ? t.charAt(0).toUpperCase() : '?';
}

/**
 * 把声明表中「尚无 rail 项」的 agent 追加到左侧导航末尾。
 * 已有 16 项完全不动（顺序/行为/图标全保留），只做增量。
 */
async function ensureRegistryRailItems() {
  const rail = document.querySelector('.platform-rail');
  if (!rail) return;
  const list = await loadAgentRegistry();
  if (!list.length) return;
  const known = new Set(
    Array.from(rail.querySelectorAll('.platform-rail-item[data-platform-rail]')).map(
      (el) => el.dataset.platformRail
    )
  );
  let added = 0;
  for (const entry of list) {
    if (!entry || !entry.id || known.has(entry.id)) continue;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'platform-rail-item';
    btn.dataset.platformRail = entry.id;
    btn.draggable = true;
    btn.dataset.action = 'openPlatformPage';
    btn.dataset.arg = entry.id;
    const label = document.createElement('span');
    label.className = 'platform-rail-label';
    label.textContent = entry.name || entry.id;
    const initial = document.createElement('span');
    initial.className = 'platform-rail-initial';
    initial.textContent = _agentInitial(entry.name || entry.id);
    const iconWrap = document.createElement('span');
    iconWrap.className = 'platform-rail-icon';
    iconWrap.setAttribute('aria-hidden', 'true');
    // 图标约定：assets/icons/platform-<id>.svg；有图用图，无图回退首字母
    // （社区加 agent 时放一张同名 svg 即可，无需改代码）
    const iconImg = document.createElement('img');
    iconImg.src = './assets/icons/' + (entry.icon || 'platform-' + entry.id + '.svg');
    iconImg.alt = '';
    iconImg.onload = () => {
      initial.style.display = 'none';
    };
    iconImg.onerror = () => {
      iconImg.remove();
    };
    iconWrap.appendChild(iconImg);
    iconWrap.appendChild(initial);
    const handle = document.createElement('span');
    handle.className = 'platform-rail-handle';
    handle.draggable = true;
    handle.setAttribute('aria-hidden', 'true');
    btn.appendChild(handle);
    btn.appendChild(iconWrap);
    btn.appendChild(label);
    rail.appendChild(btn);
    known.add(entry.id);
    added++;
  }
  if (added && typeof addLog === 'function') addLog('info', 'Agent 声明表新增 ' + added + ' 个入口');
}

/** 通用页：填 Hero + 配置路径，渲染版本行 */
async function openGenericAgentPage(platformId) {
  const list = await loadAgentRegistry();
  const entry = list.find((e) => e.id === platformId);
  if (!entry) {
    showCustomAlert('未在 Agent 声明表中找到: ' + platformId, '未知 Agent', 'error');
    return;
  }
  const title = document.getElementById('generic-agent-title');
  const initial = document.getElementById('generic-agent-initial');
  const vendor = document.getElementById('generic-agent-vendor');
  const pathInput = document.getElementById('generic-agent-config-path');
  const note = document.getElementById('generic-agent-note');
  if (title) title.textContent = entry.name || entry.id;
  if (initial) initial.textContent = _agentInitial(entry.name || entry.id);
  if (vendor) vendor.textContent = entry.vendor || '声明式接入';
  if (pathInput) {
    pathInput.value = entry.config_path || entry.config_dir || '';
    pathInput.title = pathInput.value;
  }
  if (note) {
    const parts = [];
    if (entry.installed) {
      parts.push('该 agent 由 Agent 声明表注册；配置路径与版本由声明驱动。');
    } else {
      parts.push('未检测到安装证据。安装后回到本页，点「刷新状态」即可点亮。');
    }
    if (entry.current_model) {
      parts.push('当前写入模型：' + entry.current_model + '。');
    }
    note.textContent = parts.join('');
  }
  navigateTo('platform-generic');
  setPlatformRailActive(platformId);
  globalThis._currentGenericAgent = platformId;
  renderHeroVersion(platformId, 'generic-agent-version');
  if (typeof fillGenericAgentProviders === 'function') {
    fillGenericAgentProviders().catch(() => {});
  }
}

/**
 * 填充通用页的供应商下拉（只列「已启用且有 key」的——不可用的供应商
 * 选了也会失败，不如不展示）。
 */
async function fillGenericAgentProviders(selectedId) {
  const sel = document.getElementById('generic-agent-provider');
  if (!sel) return;
  let list = [];
  try {
    const store = await invoke('load_providers');
    list = (store && store.providers ? store.providers : []).filter(
      (p) => p.enabled && String(p.apiKey || '').trim()
    );
  } catch (e) {
    if (typeof addLog === 'function') addLog('warn', '读取供应商列表失败: ' + String(e?.message || e));
  }
  if (!list.length) {
    sel.innerHTML = '<option value="">（无可用供应商，请先添加）</option>';
    sel.disabled = true;
    globalThis._genericProviders = [];
    fillGenericAgentModels();
    return;
  }
  sel.disabled = false;
  globalThis._genericProviders = list;
  const keep = selectedId || sel.value;
  sel.innerHTML = list
    .map((p) => {
      const label = p.name || p.id;
      return '<option value="' + p.id + '">' + label + '</option>';
    })
    .join('');
  if (keep && list.some((p) => p.id === keep)) sel.value = keep;
  // 切换供应商 → 模型选项跟着换
  sel.onchange = () => fillGenericAgentModels();
  fillGenericAgentModels();
}

/**
 * 填充模型下拉：选项来自所选供应商的 models 列表（为空则回退默认模型）。
 * 模型只影响「写入配置的值」，不做模型池管理（那是配置式平台页的职责）。
 */
function fillGenericAgentModels() {
  const sel = document.getElementById('generic-agent-model');
  if (!sel) return;
  const provSel = document.getElementById('generic-agent-provider');
  const list = globalThis._genericProviders || [];
  const current = list.find((p) => p.id === (provSel ? provSel.value : ''));
  const models = (current && Array.isArray(current.models) ? current.models : []).filter(Boolean);
  const fallback = current && current.defaultModel ? [current.defaultModel] : [];
  const options = models.length ? models : fallback;
  if (!options.length) {
    sel.innerHTML = '<option value="">（默认模型）</option>';
    return;
  }
  const keep = current && current.defaultModel;
  sel.innerHTML = options
    .map((m) => '<option value="' + m + '">' + m + '</option>')
    .join('');
  if (keep && options.includes(keep)) sel.value = keep;
}

/** 通用页「一键接入」：按所选供应商写入 endpoint/key/model */
async function genericAgentApply() {
  const platformId = globalThis._currentGenericAgent;
  if (!platformId) return;
  if (!invoke && !(typeof bindTauriBridge === 'function' && bindTauriBridge())) {
    showCustomAlert('Tauri 通道未就绪，请重启 AnyBridge 后重试。', '接入', 'error');
    return;
  }
  const sel = document.getElementById('generic-agent-provider');
  const providerId = sel && !sel.disabled ? sel.value : '';
  const modelSel = document.getElementById('generic-agent-model');
  const chosenModel = modelSel && modelSel.value ? modelSel.value : null;
  try {
    const msg = await invoke('apply_declared_platform', {
      platform: platformId,
      providerId: providerId || null,
      model: chosenModel,
    });
    if (typeof showBottomToast === 'function') {
      showBottomToast(msg, 'success', { duration: 5200 });
    } else {
      showCustomAlert(msg, '接入完成', 'success');
    }
    if (typeof addLog === 'function') addLog('ok', msg);
    await openGenericAgentPage(platformId);
  } catch (e) {
    showCustomAlert(String(e?.message || e), '接入失败', 'error');
    if (typeof addLog === 'function') addLog('err', '声明式接入失败: ' + String(e?.message || e));
  }
}

/** 通用页「停止接入」：从 .anybridge-bak 还原 */
async function genericAgentRestore() {
  const platformId = globalThis._currentGenericAgent;
  if (!platformId) return;
  if (!invoke && !(typeof bindTauriBridge === 'function' && bindTauriBridge())) {
    showCustomAlert('Tauri 通道未就绪，请重启 AnyBridge 后重试。', '停止接入', 'error');
    return;
  }
  try {
    const msg = await invoke('restore_declared_platform', { platform: platformId });
    if (typeof showBottomToast === 'function') {
      showBottomToast(msg, 'success');
    } else {
      showCustomAlert(msg, '已还原', 'success');
    }
    if (typeof addLog === 'function') addLog('ok', msg);
    await openGenericAgentPage(platformId);
  } catch (e) {
    showCustomAlert(String(e?.message || e), '停止接入失败', 'error');
  }
}

/** 通用页「刷新状态」：清缓存后重新拉声明表 + 重渲版本行 */
async function refreshGenericAgentStatus() {
  const platformId = globalThis._currentGenericAgent;
  if (!platformId) return;
  _agentRegistryCache.at = 0;
  _agentRegistryCache.list = [];
  if (typeof addLog === 'function') addLog('info', '刷新 ' + platformId + ' 状态…');
  await openGenericAgentPage(platformId);
}

/** 通用页「查看配置」：只读展示声明文件内容 */
async function openGenericAgentConfig() {
  const platformId = globalThis._currentGenericAgent;
  if (!platformId) return;
  if (!invoke && !(typeof bindTauriBridge === 'function' && bindTauriBridge())) return;
  try {
    const text = await invoke('read_agent_config_file', { platform: platformId });
    const clipped = text.length > 4000 ? text.slice(0, 4000) + '\n…（已截断）' : text;
    showCustomAlert(clipped, platformId + ' 配置（只读）', 'info');
  } catch (e) {
    showCustomAlert(String(e?.message || e), '读取配置失败', 'error');
  }
}

// data-action 分发走 window[name]，追加在 IIFE 外的函数需显式导出
globalThis.ensureRegistryRailItems = ensureRegistryRailItems;
globalThis.openGenericAgentPage = openGenericAgentPage;
globalThis.openGenericAgentConfig = openGenericAgentConfig;
globalThis.genericAgentApply = genericAgentApply;
globalThis.fillGenericAgentProviders = fillGenericAgentProviders;
globalThis.fillGenericAgentModels = fillGenericAgentModels;
globalThis.refreshGenericAgentStatus = refreshGenericAgentStatus;
globalThis.updatePlatformAgentAction = updatePlatformAgentAction;
globalThis.genericAgentRestore = genericAgentRestore;
globalThis.loadAgentRegistry = loadAgentRegistry;
globalThis.inferProviderApiFormat = inferProviderApiFormat;

// 首屏立即同步 rail 扩展项（不依赖延迟 timer，也不依赖用户点击「刷新检测」）
if (typeof document !== 'undefined') {
  const bootRegistryRail = () => {
    Promise.resolve().then(() => {
      try {
        if (typeof ensureRegistryRailItems === 'function') ensureRegistryRailItems().catch(() => {});
      } catch (_) {}
    });
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootRegistryRail);
  } else {
    bootRegistryRail();
  }
}

// ─── 平台页原生重试设置 ───
async function renderPlatformNativeRetry() {
  if (!invoke) return;
  try {
    const map = await invoke('load_model_map');
    const e = map?.enhancement || {};
    const reqEl = document.getElementById('platform-codex-request-max-retries');
    const streamEl = document.getElementById('platform-codex-stream-max-retries');
    const claudeEl = document.getElementById('platform-claude-max-retries');
    if (reqEl) reqEl.value = e.codexRequestMaxRetries ?? 10;
    if (streamEl) streamEl.value = e.codexStreamMaxRetries ?? 10;
    if (claudeEl) claudeEl.value = e.claudeMaxRetries ?? 10;
  } catch (_) { /* ignore */ }
}

async function saveCodexNativeRetry(input) {
  if (!invoke) return;
  const id = input?.id;
  const key = id === 'platform-codex-request-max-retries' ? 'codexRequestMaxRetries'
    : id === 'platform-codex-stream-max-retries' ? 'codexStreamMaxRetries' : null;
  if (!key) return;
  const val = Math.max(0, Math.min(100, parseInt(input.value, 10) || 0));
  input.value = val;
  try {
    const map = await invoke('load_model_map');
    if (!map.enhancement) map.enhancement = {};
    map.enhancement[key] = val;
    await invoke('save_model_map', { map });
    if (globalThis.modelMapStore && globalThis.modelMapStore.enhancement) {
      globalThis.modelMapStore.enhancement[key] = val;
    }
    // 重新应用当前 Codex 配置，让重试值立即写入 config.toml
    const info = platformInfoOf('codex');
    if (info?.currentProviderId && info.managedByAnyBridge) {
      try { await invoke('switch_platform', { platform: 'codex', providerId: info.currentProviderId }); } catch (_) { /* 静默 */ }
    }
    if (typeof addLog === 'function') addLog('ok', `已保存 Codex 原生重试: ${key} = ${val}`);
  } catch (e) {
    if (typeof addLog === 'function') addLog('err', '保存 Codex 原生重试失败: ' + e);
  }
}

async function saveClaudeNativeRetry(input) {
  if (!invoke) return;
  const val = Math.max(0, Math.min(15, parseInt(input.value, 10) || 0));
  input.value = val;
  try {
    const map = await invoke('load_model_map');
    if (!map.enhancement) map.enhancement = {};
    map.enhancement.claudeMaxRetries = val;
    await invoke('save_model_map', { map });
    if (globalThis.modelMapStore && globalThis.modelMapStore.enhancement) {
      globalThis.modelMapStore.enhancement.claudeMaxRetries = val;
    }
    // 重新应用当前 Claude Code 配置，让重试值立即写入 settings.json
    const info = platformInfoOf('claude-code');
    if (info?.currentProviderId && info.managedByAnyBridge) {
      try { await invoke('switch_platform', { platform: 'claude-code', providerId: info.currentProviderId }); } catch (_) { /* 静默 */ }
    }
    if (typeof addLog === 'function') addLog('ok', `已保存 Claude Code 原生重试: claudeMaxRetries = ${val}`);
  } catch (e) {
    if (typeof addLog === 'function') addLog('err', '保存 Claude Code 原生重试失败: ' + e);
  }
}

// ---- P3 globalThis mirror ----
(function mirrorFns(g) {
  g.renderPlatformNativeRetry = renderPlatformNativeRetry;
  g.saveCodexNativeRetry = saveCodexNativeRetry;
  g.saveClaudeNativeRetry = saveClaudeNativeRetry;
  g.renderHeroVersion = renderHeroVersion;
  g.updatePlatformAgentAction = updatePlatformAgentAction;
  g.loadAgentRegistry = loadAgentRegistry;
  g._agentInitial = _agentInitial;
  g.ensureRegistryRailItems = ensureRegistryRailItems;
  g.openGenericAgentPage = openGenericAgentPage;
  g.fillGenericAgentProviders = fillGenericAgentProviders;
  g.fillGenericAgentModels = fillGenericAgentModels;
  g.genericAgentApply = genericAgentApply;
  g.genericAgentRestore = genericAgentRestore;
  g.refreshGenericAgentStatus = refreshGenericAgentStatus;
  g.openGenericAgentConfig = openGenericAgentConfig;
})(globalThis);
