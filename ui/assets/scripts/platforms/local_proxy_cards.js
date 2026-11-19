// platforms/local_proxy_cards.js — split from 55-platforms.js
function platformLocalProxyConfigId(platformId) {
  return `anybridge-local-proxy-${platformId}`;
}

function platformLocalProxyRuntime(platformId) {
  if (typeof getLocalProxyRuntimeConfig !== 'function') return null;
  return getLocalProxyRuntimeConfig(platformId);
}


function openProxyRoutesFromPlatform() {
  if (typeof openProxyPanel === 'function') {
    openProxyPanel('routes');
  } else if (typeof navigateTo === 'function') {
    navigateTo('proxy');
  }
}

function platformLocalProxyCard(platformId, info) {
  if (platformId === 'codex') return null;
  const runtime = platformLocalProxyRuntime(platformId);
  if (!runtime) return null;
  const isClaude = platformId === 'claude-code';
  const isOpenCode = platformId === 'opencode';
  const isGrok = platformId === 'grok';
  const localProxyId = platformLocalProxyConfigId(platformId);
  const live = isOpenCode
    ? (Array.isArray(info?.liveProviderIds) && info.liveProviderIds.includes(localProxyId))
    : false;
  const current = isOpenCode
    ? info?.currentProviderId === localProxyId
    : isClaude
      ? (typeof claudeCodeProviderIsCurrent === 'function' && claudeCodeProviderIsCurrent(runtime, info))
      : isGrok
        ? (info?.currentProviderId === localProxyId || info?.currentProviderId === grok_sanitize_key(localProxyId))
        : (typeof codexProviderIsCurrent === 'function' && codexProviderIsCurrent(runtime, info));
  return {
    platformId,
    name: 'AnyBridge 内置供应商',
    description: isClaude
      ? '通过 AnyBridge Claude 兼容入口转发到内置模型列表、网关增强和日志统计。'
      : '通过 AnyBridge OpenAI 兼容入口转发到内置模型列表、网关增强和日志统计。',
    typeLabel: isOpenCode && live ? (current ? '当前使用' : '已加入') : '本地',
    tone: isOpenCode && live ? (current ? 'local live' : 'local') : 'local',
    current: !!current,
    currentLabel: '当前使用',
    model: runtime.defaultModel || '未配置',
    endpoint: runtime.endpoint,
    protocol: isClaude ? 'anthropic-compatible' : ((isOpenCode || isGrok) ? 'openai-compatible' : 'responses'),
    configAction: 'openProxyRoutesFromPlatform()',
    configLabel: '配置内置模型',
    action: `applyLocalProxyPlatformConfig(${platformJsArg(platformId)})`,
    actionLabel: '切换',
    removeAction: isOpenCode && live ? `removeOpenCodeProviderConfig(${platformJsArg(localProxyId)})` : '',
    removeLabel: '移除',
  };
}

function upsertById(list, item) {
  const arr = Array.isArray(list) ? list : [];
  const idx = arr.findIndex(x => x && x.id === item.id);
  if (idx >= 0) arr[idx] = { ...arr[idx], ...item };
  else arr.push(item);
  return arr;
}

async function ensureLocalProxyPlatformConfig(platformId) {
  if (platformId === 'codex') {
    throw new Error('Codex 已使用独立配置的「路由模式（本地网关）」接入 AnyBridge 内置供应商，不再支持旧版快捷卡片。');
  }
  if (typeof ensureLocalProxyConfig === 'function') await ensureLocalProxyConfig({});
  const runtime = platformLocalProxyRuntime(platformId);
  if (!runtime) throw new Error('本地网关配置未初始化');
  if (!runtime.apiKey) throw new Error('本地网关 key 尚未生成');
  const models = Array.isArray(runtime.models) && runtime.models.length
    ? runtime.models
    : [];
  if (!models.length) {
    throw new Error('尚未配置启用的内置模型，请先到「网关 > 模型列表」添加模型。');
  }
  const model = runtime.defaultModel || models[0];
  const base = {
    id: platformLocalProxyConfigId(platformId),
    name: 'AnyBridge 内置供应商',
    apiHost: runtime.apiHost,
    apiPath: runtime.apiPath,
    apiKey: runtime.apiKey,
    defaultModel: model,
    models,
    sourceProviderId: 'local-proxy',
    sourceProviderName: 'AnyBridge',
    localProxy: true,
  };

  const applyUpdate = store => {
    if (platformId === 'claude-code') {
      const settingsConfig = typeof claudeCodeBuildSettingsConfig === 'function'
        ? claudeCodeBuildSettingsConfig(runtime.endpoint, runtime.apiKey, model, null)
        : null;
      store.claudeCodeConfigs = upsertById(store.claudeCodeConfigs, { ...base, settingsConfig });
    } else if (platformId === 'opencode') {
      const settingsConfig = typeof opencodeBuildSettingsConfig === 'function'
        ? opencodeBuildSettingsConfig('AnyBridge 内置供应商', runtime.endpoint, runtime.apiKey, models, null)
        : null;
      store.opencodeConfigs = upsertById(store.opencodeConfigs, { ...base, settingsConfig });
    } else if (platformId === 'codex') {
      store.codexConfigs = upsertById(store.codexConfigs, base);
    } else if (platformId === 'grok') {
      store.grokConfigs = upsertById(store.grokConfigs, {
        ...base,
        apiBackend: 'chat_completions',
      });
    } else {
      store.providers = upsertById(store.providers, {
        id: platformLocalProxyConfigId(platformId),
        name: 'AnyBridge 内置供应商',
        apiHost: runtime.apiHost,
        apiPath: runtime.apiPath,
        apiKey: runtime.apiKey,
        defaultModel: model,
        models,
        apiFormat: runtime.apiFormat || 'openai',
        enabled: true,
        localProxy: true,
      });
    }
  };

  if (typeof mutateProviderStore === 'function') {
    const ok = await mutateProviderStore(applyUpdate, { silent: true });
    if (!ok) throw new Error('本地网关平台配置保存失败');
  } else {
    applyUpdate(providerStore);
  }
  return platformLocalProxyConfigId(platformId);
}

async function applyLocalProxyPlatformConfig(platformId) {
  const def = platformDef(platformId);
  const providerId = await ensureLocalProxyPlatformConfig(platformId);
  const runtime = platformLocalProxyRuntime(platformId);
  const isOpenCode = platformId === 'opencode';
  const info = platformInfoOf(platformId) || {};
  const live = isOpenCode && Array.isArray(info.liveProviderIds) && info.liveProviderIds.includes(providerId);
  const ok = await showCustomConfirm(
    `${isOpenCode ? (live ? '将把 AnyBridge 内置供应商设为 OpenCode 当前 model。' : '将把 AnyBridge 内置供应商加入 OpenCode live provider 列表，并设为当前 model。') : `将把 ${def.name} 切换到「AnyBridge 内置供应商」。`}\n\n模型列表：${(runtime.models || []).join(', ') || '未配置'}\n地址：${runtime.endpoint}\n\n请求会先进入 AnyBridge 本地网关；如果网关未启动，外部工具会连接失败。`,
    isOpenCode ? (live ? '设为当前' : '加入并设为当前') : '切换到内置供应商',
    'warn'
  );
  if (!ok) return;
  setPlatformBusy(platformId, true);
  showSwitchProgress(platformId, '正在准备切换到内置供应商…');
  try {
    const result = await invoke('switch_platform', { platform: platformId, providerId });
    if (typeof loadProviders === 'function') await loadProviders();
    await refreshPlatforms({ silent: true });
    if (typeof addLog === 'function') addLog('ok', result.message || `${def.name} 已切换到 AnyBridge 内置供应商`);
    showCustomAlert(result.message || `${def.name} 已切换到 AnyBridge 内置供应商。`, isOpenCode ? '设置完成' : '切换完成', 'success');
  } catch (e) {
    if (typeof addLog === 'function') addLog('err', `${def.name} 切换到内置供应商失败: ${e}`);
    showCustomAlert(String(e), isOpenCode ? '设置失败' : '切换失败', 'error');
  } finally {
    hideSwitchProgress();
    setPlatformBusy(platformId, false);
    renderPlatformDetailStatuses();
  }
}

// ---- P3 globalThis mirror ----
(function mirrorFns(g) {
  g.platformLocalProxyConfigId = platformLocalProxyConfigId;
  g.platformLocalProxyRuntime = platformLocalProxyRuntime;
  g.openProxyRoutesFromPlatform = openProxyRoutesFromPlatform;
  g.platformLocalProxyCard = platformLocalProxyCard;
  g.upsertById = upsertById;
  g.ensureLocalProxyPlatformConfig = ensureLocalProxyPlatformConfig;
  g.applyLocalProxyPlatformConfig = applyLocalProxyPlatformConfig;
})(globalThis);
