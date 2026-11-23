// platforms/core.js — 平台权威元数据对接、状态卡片渲染与控制台入口

// platforms/core.js — split from 55-platforms.js
// ES module (P3) — vars on globalThis; functions kept + mirrored for hoist + data-action.
// More platforms: persistent config switching for Claude Code / Codex / CodeBuddy / OpenCode / ZCode.

globalThis.platformInfos = [];
globalThis.platformBusy = null;
globalThis.claudeCodeConfigSearch = '';
globalThis.claudeCodeConfigEditorMode = 'create';
globalThis.claudeCodeConfigModelFetchSeq = 0;
globalThis.claudeCodeRawConfigSyncing = false;
globalThis.opencodeConfigSearch = '';
globalThis.opencodeConfigEditorMode = 'create';
globalThis.opencodeConfigModelFetchSeq = 0;
globalThis.opencodeRawConfigSyncing = false;

// 纯 UI 展示文案（configHint / summary / note）。平台权威元数据（name / vendor / requiredApiFormat / configPath）
// 由后端 agent_spec.rs（detect_platforms + get_agent_registry）下发，禁止在此重复维护或覆盖。
globalThis.PLATFORM_UI_COPY = {
  'claude-code': {
    configHint: '~/.claude/settings.json',
    summary: '写入 ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN / 默认模型',
    note: '原有 MCP、权限、hooks、语言等设置会保留。',
  },
  'claude-desktop': {
    configHint: 'Claude-3p/claude_desktop_config.json',
    summary: '开启本地路由模式，映射 Sonnet / Opus / Haiku 模型',
    note: '需保持 AnyBridge 运行以提供本地路由服务，切换后重启 Claude Desktop 生效。',
  },
  codex: {
    configHint: '~/.codex/config.toml',
    summary: '写入 model_provider = "codex_local_access" 和 model_providers.codex_local_access',
    note: '所选中转站必须支持 OpenAI Responses API。',
  },
  antigravity: {
    configHint: 'Antigravity/User/settings.json',
    summary: '写入 jetski.cloudCodeUrl，将独立桌面端请求重定向至 AnyBridge 内置供应商',
    note: '支持独立 Agent 桌面控制台接入、上下文长记忆保护与模型下拉列表注入。',
  },
  'antigravity-ide': {
    configHint: 'Antigravity IDE/User/settings.json',
    summary: '写入 jetski.cloudCodeUrl 与系统设置，本地转换并优化上下文策略',
    note: '支持 VS Code 编程 IDE 接入、上下文长记忆保护与模型下拉列表注入。',
  },
  codebuddy: {
    configHint: '~/.codebuddy/models.json',
    summary: '写入 models.json 自定义模型，使用 OpenAI Chat Completions',
    note: 'URL 会规范化为完整 /v1/chat/completions 端点。',
  },
  grok: {
    configHint: '~/.grok/config.toml',
    summary: '写入 [models].default 与 [model.anybridge] 自定义端点',
    note: '原生支持 OpenAI 兼容 API，保留 config.toml 其余配置。',
  },
  opencode: {
    configHint: '~/.config/opencode/opencode.json',
    summary: '以累加模式写入 @ai-sdk/openai-compatible provider',
    note: '配置方案独立保存，应用时加入 OpenCode live provider 列表。',
  },
  zcode: {
    configHint: '~/.zcode/v2/config.json + ~/.zcode/cli/config.json',
    summary: '写入 openai-compatible provider 到 ZCode 配置',
    note: 'baseURL 会写入 ZCode 原生 provider 配置，不带 /chat/completions。',
  },
  workbuddy: {
    configHint: '~/.workbuddy/models.json',
    summary: '写入 models.json 自定义模型，使用完整 Chat Completions 端点',
    note: '会设置 useCustomProtocol=true，避免 WorkBuddy 额外拼接路径。',
  },
  hermes: {
    configHint: '~/.hermes/config.yaml',
    summary: '按供应商分组写入 custom_providers（name=供应商名，模型收敛进 models），并把首条启用模型设为默认模型',
    note: '受管条目通过本地状态快照识别（旧 anybridge- 前缀条目自动迁移），原有配置与注释会保留；Windows 上读取 %LOCALAPPDATA%\\hermes。',
  },
  'deepseek-harness': {
    configHint: '~/.dsh/settings.yaml',
    summary: '按供应商分组写入 llm-pi-ai.providers（displayName=供应商名，模型按 ID 展示），密钥存入 .credentials.yaml',
    note: '只维护 anybridge- 前缀条目，用户手写的 provider 与凭据记录会保留。',
  },
  pi: {
    configHint: '~/.pi/agent/models.json',
    summary: '以 providers 写入自定义渠道模型，并把首条启用模型设为默认模型',
    note: 'AnyBridge 只管理 anybridge- 前缀的条目，原有 provider（如 local）与其它设置会保留。',
  },
};

/// 受管模型表格平台：表格前缀 -> Rust 平台 id。
/// Pi / Hermes / DeepSeek Harness 共用同一套表格交互，差异只在读写命令与配置文件格式。
globalThis.MANAGED_MODEL_PLATFORM_IDS = {
  Pi: 'pi',
  Hermes: 'hermes',
  Dsh: 'deepseek-harness',
};

function platformEsc(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[c]));
}

function platformInfoOf(platformId) {
  return platformInfos.find(p => p.id === platformId) || null;
}

function platformMetaIds() {
  const seen = new Set();
  const ids = [];
  const push = (id) => {
    const clean = String(id || '').trim();
    if (!clean || seen.has(clean)) return;
    seen.add(clean);
    ids.push(clean);
  };
  if (typeof PLATFORM_UI_COPY === 'object' && PLATFORM_UI_COPY) {
    Object.keys(PLATFORM_UI_COPY).forEach(push);
  }
  if (Array.isArray(platformInfos)) {
    platformInfos.forEach(p => push(p && p.id));
  }
  const regList = typeof _agentRegistryCache === 'object' && Array.isArray(_agentRegistryCache?.list)
    ? _agentRegistryCache.list
    : [];
  regList.forEach(r => push(r && r.id));
  return ids;
}

function platformDef(platformId) {
  const info = typeof platformInfoOf === 'function' ? platformInfoOf(platformId) : null;
  const regList = typeof _agentRegistryCache === 'object' && Array.isArray(_agentRegistryCache?.list)
    ? _agentRegistryCache.list
    : [];
  const reg = regList.find(e => e && e.id === platformId) || null;
  const copy = (typeof PLATFORM_UI_COPY === 'object' && PLATFORM_UI_COPY && PLATFORM_UI_COPY[platformId])
    || {};
  const fallbackName = String(platformId || '')
    .split('-')
    .filter(Boolean)
    .map(w => w === 'ide' ? 'IDE' : (w.charAt(0).toUpperCase() + w.slice(1)))
    .join(' ') || platformId;
  return {
    id: platformId,
    name: (info && info.displayName) || (reg && reg.name) || copy.name || fallbackName,
    vendor: (info && info.vendor) || (reg && reg.vendor) || copy.vendor || '',
    requiredApiFormat: (info && info.requiredApiFormat) || (reg && reg.api_format) || copy.requiredApiFormat || 'openai',
    configHint: copy.configHint || (reg && reg.config_path) || '',
    summary: copy.summary || '',
    note: copy.note || '',
  };
}

function isRevealablePath(path) {
  const s = String(path || '').trim();
  if (!s) return false;
  // ~/.xxx 也允许点击；后端 reveal_path 负责展开 home
  if (s === '~' || s.startsWith('~/') || s.startsWith('~\\')) return true;
  return s.includes('/') || s.includes('\\') || /^[A-Za-z]:/.test(s);
}

async function revealConfigPath(path) {
  if (!isRevealablePath(path)) return;
  if (!invoke && !bindTauriBridge()) return;
  try {
    await invoke('reveal_path', { path: String(path) });
  } catch (e) {
    if (typeof addLog === 'function') addLog('err', '打开配置目录失败: ' + e);
  }
}

function bindRevealPathLabel(labelId, path) {
  const el = document.getElementById(labelId);
  if (!el) return;
  const display = String(path || '').trim() || el.textContent || '';
  el.textContent = display;
  if (isRevealablePath(display)) {
    el.classList.add('reveal-path');
    el.title = '点击打开所在文件夹';
    el.onclick = () => revealConfigPath(display);
  } else {
    el.classList.remove('reveal-path');
    el.title = '';
    el.onclick = null;
  }
}

function platformFormatLabel(fmt) {
  const v = String(fmt || '').trim().toLowerCase();
  if (v === 'openai') return 'OpenAI';
  if (v === 'anthropic') return 'Anthropic';
  if (v === 'gemini') return 'Gemini';
  return v ? v.toUpperCase() : 'OpenAI';
}

function platformIsLocalProxyConfig(config) {
  return !!(config && (config.localProxy || String(config.id || '').startsWith('anybridge-local-proxy')));
}

function platformProviderList(platformId) {
  const def = platformDef(platformId);
  if (platformId === 'claude-code') {
    return Array.isArray(providerStore?.claudeCodeConfigs) ? providerStore.claudeCodeConfigs.filter(p => !platformIsLocalProxyConfig(p)) : [];
  }
  if (platformId === 'codex') {
    return Array.isArray(providerStore?.codexConfigs) ? providerStore.codexConfigs.filter(p => !platformIsLocalProxyConfig(p)) : [];
  }
  if (platformId === 'antigravity' || platformId === 'antigravity-ide') {
    return Array.isArray(providerStore?.antigravityConfigs) ? providerStore.antigravityConfigs.filter(p => !platformIsLocalProxyConfig(p)) : [];
  }
  if (platformId === 'opencode') {
    return Array.isArray(providerStore?.opencodeConfigs) ? providerStore.opencodeConfigs.filter(p => !platformIsLocalProxyConfig(p)) : [];
  }
  if (platformId === 'grok') {
    return Array.isArray(providerStore?.grokConfigs) ? providerStore.grokConfigs.filter(p => !platformIsLocalProxyConfig(p)) : [];
  }
  const providers = (providerStore && Array.isArray(providerStore.providers))
    ? providerStore.providers
    : [];
  return providers.filter(p => p && p.enabled !== false && !platformIsLocalProxyConfig(p));
}

function formatPlatformTime(value) {
  const n = Number(value || 0);
  if (!Number.isFinite(n) || n <= 0) return '';
  const ms = n < 1000000000000 ? n * 1000 : n;
  try {
    return new Date(ms).toLocaleString('zh-CN', { hour12: false });
  } catch {
    return '';
  }
}

function platformSetText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

function platformSetValue(id, value) {
  const el = document.getElementById(id);
  if (!el) return;
  if (el.type === 'checkbox') el.checked = !!value;
  else el.value = value == null ? '' : String(value);
}

function platformStatusTag(label, tone) {
  return `<span class="platform-tag ${platformEsc(tone)}">${platformEsc(label)}</span>`;
}

function platformShort(value, fallback = '未配置') {
  const text = String(value || '').trim();
  return text || fallback;
}

function platformJoinUrl(host, path) {
  let base = String(host || '').trim();
  if (!base) return '';
  if (!/^https?:\/\//i.test(base)) base = `https://${base}`;
  base = base.replace(/\/+$/, '');
  const suffix = String(path || '').trim();
  if (!suffix || suffix === '/') return base;
  return `${base}/${suffix.replace(/^\/+/, '').replace(/\/+$/, '')}`.replace(/\/+$/, '');
}

function platformStripSuffix(value, suffixes) {
  let out = String(value || '').trim().replace(/\/+$/, '');
  const lower = out.toLowerCase();
  for (const suffix of suffixes) {
    if (lower.endsWith(suffix)) {
      out = out.slice(0, out.length - suffix.length).replace(/\/+$/, '');
      break;
    }
  }
  return out;
}

function platformUrlHasPath(url) {
  const raw = String(url || '');
  const idx = raw.indexOf('://');
  return idx >= 0 ? raw.slice(idx + 3).includes('/') : raw.includes('/');
}

/**
 * 供应商的上游协议：显式 wireApi 优先，否则按 API 路径判断。返回 '' 表示无法判断。
 *
 * 普通供应商在 UI 上没有 wireApi 输入项（字段恒为空字符串），
 * 端点协议这个信息实际上只存在于 apiPath 里（如 /v1/chat/completions）。
 */
function refreshCodexWireApiAutoLabel() {
  const autoOption = document.querySelector('#codex-config-wire-api option[value="auto"]');
  if (!autoOption) return;
  const sourceId = String(document.getElementById('codex-config-source-id')?.value || '').trim();
  const source = sourceId
    ? (providerStore?.providers || []).find(p => p && p.id === sourceId)
    : null;
  const guess = codexWireApiOf(source);
  autoOption.textContent = guess ? `自动识别（当前：${codexWireApiLabel(guess)}）` : '自动识别';
}

async function refreshPlatforms(options = {}) {
  if (!invoke) return;
  const btn = document.getElementById('platforms-refresh-btn');
  const showBtnLoading = !!(btn && !options.silent && !options.skipOverviewBtn);
  const forceDetect = options.force !== undefined ? !!options.force : !options.silent;
  if (showBtnLoading) {
    setLoading(btn, '检测中…');
  }

  try {
    if (options.reloadProviders !== false && typeof loadProviders === 'function') {
      await loadProviders();
    }
    // 手动点刷新 = 强制重扫（绕过指纹缓存）；自动连带刷新（silent）吃指纹缓存
    platformInfos = await invoke('detect_platforms', { force: forceDetect }) || [];
    renderPlatformCards();
    renderPlatformDetailStatuses();
    renderPlatformProviderOptions();
    // Hero 版本行（无专属 render 的平台统一在此刷；有专属 render 的平台另行调用）
    if (typeof refreshAllHeroVersions === 'function') {
      refreshAllHeroVersions();
    }
    // 声明表新增的 agent → 追加到 rail（已有项完全不动）
    if (typeof ensureRegistryRailItems === 'function') {
      ensureRegistryRailItems().catch(() => {});
    }
  } catch (e) {
    const grid = document.getElementById('platforms-grid');
    if (grid) {
      grid.innerHTML = `<div class="platforms-empty">检测失败：${platformEsc(e)}</div>`;
    }
    if (typeof addLog === 'function') addLog('err', '平台检测失败: ' + e);
    if (options.throwOnError) throw e;
  } finally {
    if (showBtnLoading) {
      clearLoading(btn);
    }
  }
}

/**
 * 刷新所有「无专属 render 函数」平台的 Hero 版本行
 * （有专属 render 的平台在各自函数里调，避免重复触发）。
 * 元素不存在的页面自动跳过（renderHeroVersion 判空）。
 */
/**
 * 当前左侧 rail 选中的平台 id（用户所见即所得的唯一权威来源）。
 * 注意：不能用 getTargetIde()——那是「目标 IDE」下拉框的值，与 rail
 * 不同步；用它刷新共用页版本行会把 Devin 的版本画到 Windsurf 页上
 * （实测事故）。
 */
function currentRailPlatform() {
  const el = document.querySelector('.platform-rail-item.active[data-platform-rail]');
  return (el && el.dataset && el.dataset.platformRail) || null;
}

function refreshAllHeroVersions() {
  if (typeof renderHeroVersion !== 'function') return;
  // 共用页（models）的版本行按 rail 实际选中项刷新；rail 无 active 时
  // 回退到目标 IDE 选择器（两者正常同步，异常时也不留空窗）
  const ideTarget =
    currentRailPlatform() ||
    (typeof getTargetIde === 'function' ? normalizeIdeProxyTargetValue(getTargetIde()) : null);
  if (ideTarget && ['windsurf', 'devin', 'cursor'].includes(ideTarget)) {
    renderHeroVersion(ideTarget, 'proxy-platform-version');
  }
  const agTarget =
    typeof getAntigravityTarget === 'function'
      ? getAntigravityTarget()
      : (globalThis._currentAntigravityTarget === 'antigravity-ide' ? 'antigravity-ide' : 'antigravity');
  const ids = [
    ['codebuddy', 'codebuddy-platform-version'],
    ['workbuddy', 'workbuddy-platform-version'],
    ['zcode', 'zcode-platform-version'],
    ['pi', 'pi-platform-version'],
    ['hermes', 'hermes-platform-version'],
    ['deepseek-harness', 'deepseek-harness-platform-version'],
    [agTarget, 'antigravity-platform-version'],
    // Claude Desktop：其页面自身的 refresh 函数前置了多次 await
    // （loadProxyRoutes / get_claude_desktop_status），任一处挂起就永远
    // 到不了版本行渲染（实测一直停在「检测中」）。统一在此兜住。
    ['claude-desktop', 'claude-desktop-platform-version'],
  ];
  ids.forEach(([pid, elId]) => renderHeroVersion(pid, elId));
}

function renderPlatformCards() {
  const grid = document.getElementById('platforms-grid');
  if (!grid) return;

  const ids = platformMetaIds();
  const infos = ids.map(id => {
    const def = platformDef(id);
    return platformInfoOf(id) || {
      ...def,
      displayName: def.name,
      installed: false,
      backupExists: false,
      managedByAnyBridge: false,
      currentProviderName: '',
      currentProviderId: '',
      configPath: '',
      appliedAt: '',
      codexConfig: null,
      claudeConfig: null,
    };
  });

  grid.innerHTML = infos.map(info => renderPlatformCard(info)).join('');
}

function renderPlatformCard(info) {
  const def = platformDef(info.id);
  const installed = !!info.installed;
  const backup = !!info.backupExists;
  const hasProvider = !!info.currentProviderId;
  const official = !!(info.codexConfig && info.codexConfig.isOfficial);
  const managed = info.managedByAnyBridge != null ? !!info.managedByAnyBridge : hasProvider;
  const appliedAt = formatPlatformTime(info.appliedAt);
  const providerName = info.currentProviderName || info.currentProviderId || '未接管';
  const path = info.configPath || def.configHint;
  const status = installed
    ? platformStatusTag('已检测', 'ok')
    : platformStatusTag('未检测', 'warn');
  const backupTag = backup
    ? platformStatusTag('有备份', 'info')
    : platformStatusTag('无备份', 'muted');
  const appliedTag = official
    ? platformStatusTag('官方配置', 'ok')
    : managed
    ? platformStatusTag('已接管', 'ok')
    : hasProvider
      ? platformStatusTag('外部配置', 'info')
      : platformStatusTag('未接管', 'muted');
  // 配置漂移：接管中但记账字段被外部改动（Drift，借鉴 magpie）
  const driftCount = Array.isArray(info.driftedFields) ? info.driftedFields.length : 0;
  const driftTag = driftCount ? platformStatusTag('被外部修改', 'warn') : '';
  const driftRow = driftCount
    ? `<div class="platform-card-row"><span>配置漂移</span><strong>${driftCount} 处被外部改动</strong></div>`
    : '';

  const metaParts = [...new Set([def.vendor, platformFormatLabel(def.requiredApiFormat)].map(s => String(s || '').trim()).filter(Boolean))];

  return `
    <article class="platform-card">
      <div class="platform-card-top">
        <div>
          <div class="platform-card-title">${platformEsc(def.name)}</div>
          <div class="platform-card-sub">${metaParts.map(platformEsc).join(' / ')}</div>
        </div>
        <div class="platform-card-tags">${status}${appliedTag}${backupTag}${driftTag}</div>
      </div>
      <div class="platform-card-body">
        <div class="platform-card-summary">${platformEsc(def.summary)}</div>
        <div class="platform-card-row">
          <span>当前供应商</span>
          <strong title="${platformEsc(providerName)}">${platformEsc(providerName)}</strong>
        </div>
        <div class="platform-card-row">
          <span>配置文件</span>
          <strong title="${platformEsc(path)}">${platformEsc(path)}</strong>
        </div>
        ${appliedAt ? `<div class="platform-card-row"><span>应用时间</span><strong>${platformEsc(appliedAt)}</strong></div>` : ''}
        ${driftRow}
      </div>
      <div class="platform-card-actions">
        ${info.id === 'claude-code' && driftCount && info.currentProviderId
          ? `<button class="btn-primary platform-open-btn" data-action="applyClaudeCodeProviderConfig" data-arg="${platformEsc(info.currentProviderId)}">重新接入</button>`
          : ''}
        <button class="btn-primary platform-open-btn" data-action="openPlatformPage" data-arg="${platformEsc(info.id)}">配置</button>
      </div>
    </article>
  `;
}

function renderPlatformDetailStatuses() {
  platformMetaIds().forEach(platformId => {
    const info = platformInfoOf(platformId);
    const def = platformDef(platformId);
    const el = document.getElementById(`platform-${platformId}-status`);

    if (platformId === 'codex') {
      if (info) renderCodexPageStatus(info);
      return;
    }
    if (platformId === 'antigravity' || platformId === 'antigravity-ide') {
      renderAntigravityPageStatus(info || { id: platformId, installed: false });
      return;
    }
    if (platformId === 'claude-code') {
      if (info) renderClaudeCodePageStatus(info);
      return;
    }
    if (platformId === 'opencode') {
      if (info) renderOpenCodePageStatus(info);
      return;
    }
    if (platformId === 'grok') {
      if (info) renderGrokPageStatus(info);
      return;
    }
    if (platformId === 'claude-desktop') {
      if (typeof loadClaudeDesktopConsole === 'function') {
        loadClaudeDesktopConsole();
      }
      return;
    }

    if (!el) return;

    if (!info) {
      el.innerHTML = '<div class="platform-status-line">尚未检测。</div>';
      return;
    }

    const appliedAt = formatPlatformTime(info.appliedAt);
    const providerName = info.currentProviderName || info.currentProviderId || '未接管';
    const managed = info.managedByAnyBridge != null ? !!info.managedByAnyBridge : !!info.currentProviderId;
    const installedText = info.installed
      ? '已检测到配置目录'
      : '未检测到配置目录，应用时会自动创建配置文件';
    const backupText = info.backupExists
      ? '已创建 AnyBridge 备份，可还原'
      : '尚无 AnyBridge 备份';
    const manageText = managed
      ? 'AnyBridge 当前接管'
      : info.currentProviderId
        ? '当前为外部配置'
        : '未接管';
    const codexRows = info.id === 'codex' ? renderCodexConfigRows(info.codexConfig) : '';

    el.innerHTML = `
      <div class="platform-status-grid">
        <div class="platform-status-item">
          <span>检测状态</span>
          <strong>${platformEsc(installedText)}</strong>
        </div>
        <div class="platform-status-item">
          <span>当前供应商</span>
          <strong>${platformEsc(providerName)}</strong>
        </div>
        <div class="platform-status-item">
          <span>接管状态</span>
          <strong>${platformEsc(manageText)}</strong>
        </div>
        <div class="platform-status-item">
          <span>配置文件</span>
          <strong title="${platformEsc(info.configPath || def.configHint)}">${platformEsc(info.configPath || def.configHint)}</strong>
        </div>
        <div class="platform-status-item">
          <span>备份</span>
          <strong>${platformEsc(backupText)}</strong>
        </div>
        ${codexRows}
        ${appliedAt ? `<div class="platform-status-item"><span>应用时间</span><strong>${platformEsc(appliedAt)}</strong></div>` : ''}
      </div>
      ${info.error ? `<div class="platform-error">${platformEsc(info.error)}</div>` : ''}
    `;
  });
}

function claudeCodeStatusMeta(info) {
  if (info && info.claudeConfig && info.claudeConfig.isOfficial) {
    return { label: 'Anthropic 官方', tone: 'ok' };
  }
  if (info && info.managedByAnyBridge) {
    return { label: 'AnyBridge 第三方', tone: 'info' };
  }
  if (info && info.currentProviderId) {
    return { label: '外部配置', tone: 'warn' };
  }
  return { label: '未配置', tone: 'warn' };
}

function openCodeStatusMeta(info) {
  const liveIds = Array.isArray(info?.liveProviderIds) ? info.liveProviderIds : [];
  if (info?.currentProviderId) {
    return { label: `当前：${info.currentProviderName || info.currentProviderId}`, tone: info.managedByAnyBridge ? 'info' : 'warn' };
  }
  if (liveIds.length) {
    return { label: `已加入 ${liveIds.length} 个`, tone: info.managedByAnyBridge ? 'info' : 'warn' };
  }
  return { label: '未加入', tone: 'warn' };
}

function renderClaudeCodePageStatus(info) {
  const currentLabel = document.getElementById('claude-code-current-label');

  const meta = claudeCodeStatusMeta(info);

  if (currentLabel) currentLabel.textContent = meta.label;
  bindRevealPathLabel('claude-code-config-path-label', info.configPath || platformDef('claude-code').configHint);
  renderHeroVersion('claude-code', 'claude-code-platform-version');
  renderClaudeCodeConfigList(info);
  renderPlatformNativeRetry();
}

function renderOpenCodePageStatus(info) {
  const currentLabel = document.getElementById('opencode-current-label');

  const meta = openCodeStatusMeta(info);

  if (currentLabel) currentLabel.textContent = meta.label;
  bindRevealPathLabel('opencode-config-path-label', info.configPath || platformDef('opencode').configHint);
  renderHeroVersion('opencode', 'opencode-platform-version');
  renderOpenCodeConfigList(info);
}

// ---- P3 globalThis mirror ----
(function mirrorFns(g) {
  g.platformEsc = platformEsc;
  g.platformInfoOf = platformInfoOf;
  g.platformMetaIds = platformMetaIds;
  g.platformDef = platformDef;
  g.isRevealablePath = isRevealablePath;
  g.revealConfigPath = revealConfigPath;
  g.bindRevealPathLabel = bindRevealPathLabel;
  g.platformFormatLabel = platformFormatLabel;
  g.platformIsLocalProxyConfig = platformIsLocalProxyConfig;
  g.platformProviderList = platformProviderList;
  g.formatPlatformTime = formatPlatformTime;
  g.platformSetText = platformSetText;
  g.platformSetValue = platformSetValue;
  g.platformStatusTag = platformStatusTag;
  g.platformShort = platformShort;
  g.platformJoinUrl = platformJoinUrl;
  g.platformStripSuffix = platformStripSuffix;
  g.platformUrlHasPath = platformUrlHasPath;
  g.refreshCodexWireApiAutoLabel = refreshCodexWireApiAutoLabel;
  g.refreshPlatforms = refreshPlatforms;
  g.currentRailPlatform = currentRailPlatform;
  g.refreshAllHeroVersions = refreshAllHeroVersions;
  g.renderPlatformCards = renderPlatformCards;
  g.renderPlatformCard = renderPlatformCard;
  g.renderPlatformDetailStatuses = renderPlatformDetailStatuses;
  g.claudeCodeStatusMeta = claudeCodeStatusMeta;
  g.openCodeStatusMeta = openCodeStatusMeta;
  g.renderClaudeCodePageStatus = renderClaudeCodePageStatus;
  g.renderOpenCodePageStatus = renderOpenCodePageStatus;
})(globalThis);
