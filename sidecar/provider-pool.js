// provider-pool.js — 读取 providers.json（全部供应商）+ model-map.json（槽位表），
// 为路由层提供:按 modelUid 查槽位、按 providerId 解析连接信息。
//
// 性能优化：底层走 config-cache.js，进程内缓存 + mtime 失效，
// 高并发不再每次 readFileSync。

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { getModelMapConfig, getProviders, getSlots, markProvidersDirty } from './config-cache.js';

function configDir() {
  if (process.env.BYOK_CONFIG_DIR) return process.env.BYOK_CONFIG_DIR;
  const next = appConfigDir('anybridge');
  if (fs.existsSync(next)) return next;
  const legacy = appConfigDir('ide-byok');
  return fs.existsSync(legacy) ? legacy : next;
}

function appConfigDir(name) {
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', name);
  if (process.platform === 'linux') return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), name);
  return path.join(os.homedir(), 'AppData', 'Roaming', name);
}

function providersPath() {
  return path.join(configDir(), 'providers.json');
}

function readJson(file) {
  try {
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    console.error(`[pool] failed to read ${file}: ${e.message}`);
    return null;
  }
}

function writeJsonAtomic(file, data) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

function cleanApiPath(value) {
  const raw = String(value || '').trim();
  if (!raw || raw === '/') return '';
  return `/${raw.replace(/^\/+/, '').replace(/\/+$/, '')}`;
}

function isOfficialDashScopeHost(host) {
  const h = String(host || '')
    .replace(/^https?:\/\//i, '')
    .split('/')[0]
    .split(':')[0]
    .toLowerCase();
  return /^(dashscope|dashscope-intl|dashscope-us)\.aliyuncs\.com$/.test(h);
}

function normalizeOpenAIApiPath(host, apiPath) {
  const path = cleanApiPath(apiPath);
  const lower = path.toLowerCase();

  // DashScope's OpenAI-compatible BYOK endpoint is not the native /api/v1 API.
  // Users usually paste the official base_url ending in /compatible-mode/v1.
  if (isOfficialDashScopeHost(host)) {
    if (lower.endsWith('/compatible-mode/v1/chat/completions') || lower.endsWith('/compatible-mode/v1/responses')) return path;
    if (lower === '/v1/chat/completions' || lower === '/api/v1/chat/completions') {
      return '/compatible-mode/v1/chat/completions';
    }
    if (lower === '/v1/responses' || lower === '/api/v1/responses') {
      return '/compatible-mode/v1/responses';
    }
    if (!path || lower === '/v1' || lower === '/api/v1' || lower === '/compatible-mode' || lower === '/compatible-mode/v1') {
      return '/compatible-mode/v1/chat/completions';
    }
    if (lower.endsWith('/compatible-mode/v1')) return `${path}/chat/completions`;
    if (lower.endsWith('/compatible-mode')) return `${path}/v1/chat/completions`;
  }

  if (lower.endsWith('/chat/completions') || lower.endsWith('/responses')) return path;

  if (!path) return '/v1/chat/completions';
  if (lower.endsWith('/v1')) return `${path}/chat/completions`;
  return path;
}

function normalizeAnthropicApiPath(apiPath) {
  const path = cleanApiPath(apiPath);
  const lower = path.toLowerCase();
  if (!path) return '/v1/messages';
  if (lower.endsWith('/messages')) return path;
  if (lower.endsWith('/v1')) return `${path}/messages`;
  return `${path}/v1/messages`;
}

function shouldUseAnthropicBearerAuth(host, apiPath) {
  const hostname = String(host || '').split('/')[0].split(':')[0].toLowerCase();
  const path = normalizeAnthropicApiPath(apiPath).toLowerCase();
  return hostname === 'api.deepseek.com' && path.startsWith('/anthropic/');
}

function inferApiFormatFromPath(apiPath) {
  const path = cleanApiPath(apiPath).toLowerCase();
  if (!path) return null;
  if (path.includes(':generatecontent') || path.includes('/v1beta/models/')) {
    return { error: '检测到 Gemini 原生 generateContent 路径，但聊天代理尚未接入 Gemini 原生协议' };
  }
  if (path.endsWith('/messages') || path.includes('/messages/')) return 'anthropic';
  if (path.endsWith('/chat/completions') || path.endsWith('/responses')) return 'openai';
  if (path.includes('/openai/') || path.includes('/compatible-mode/')) return 'openai';
  return null;
}

function inferApiFormatFromHost(host) {
  const hostname = String(host || '')
    .replace(/^https?:\/\//i, '')
    .split('/')[0]
    .split(':')[0]
    .toLowerCase();
  if (hostname === 'api.anthropic.com') return 'anthropic';
  if (hostname === 'api.openai.com' || hostname.endsWith('.openai.azure.com')) return 'openai';
  return null;
}

function inferTargetRouteFormat({ targetApiFormat, unlockApiFormat, targetUnlock, explicitPath, providerPath, host }) {
  if (unlockApiFormat) return { format: unlockApiFormat, source: targetUnlock };
  if (targetApiFormat) return { format: targetApiFormat, source: 'target-apiFormat' };

  const targetPathFormat = inferApiFormatFromPath(explicitPath);
  if (targetPathFormat?.error) return targetPathFormat;
  if (targetPathFormat) return { format: targetPathFormat, source: 'target-apiPath' };

  const providerPathFormat = inferApiFormatFromPath(providerPath);
  if (providerPathFormat?.error) return providerPathFormat;
  if (providerPathFormat) return { format: providerPathFormat, source: 'provider-apiPath' };

  const hostFormat = inferApiFormatFromHost(host);
  if (hostFormat) return { format: hostFormat, source: 'host' };

  return { format: 'openai', source: 'auto-default-openai' };
}

// 兼容旧 API：每次直接返回缓存的 providers Map（config-cache 已处理 mtime）。
export function loadProviders() {
  return getProviders();
}

export function loadModelMapConfig() {
  return getModelMapConfig();
}

// 返回该 modelUid 对应的槽位（启用且有 targets 才算可路由），否则 null。
export function getSlot(modelUid) {
  if (!modelUid) return null;
  const entry = getSlots().get(modelUid);
  if (!entry || entry.kind !== 'slot') return null;
  const slot = entry.data;
  if (!slot || slot.enabled === false) return null;
  return slot;
}

// 返回该 modelUid 对应的注入项（任意时刻都返回，未配置也返回供 chat.js 报"未配置"），否则 null。
// kind: 'unconfigured'（已注入但没配 providerId/model）/ 'configured'（可用）
export function getInjectedByUid(modelUid) {
  if (!modelUid) return null;
  const entry = getSlots().get(modelUid);
  if (!entry || entry.kind !== 'injected') return null;
  const inj = entry.data;
  const hasProvider = inj.providerId && inj.providerId.length > 0;
  const hasModel = inj.model && inj.model.trim().length > 0;
  return {
    label: inj.label,
    modelUid: inj.modelUid,
    providerId: hasProvider ? inj.providerId : null,
    model: hasModel ? inj.model : null,
    apiFormat: inj.apiFormat || inj.api_format || null,
    apiPath: inj.apiPath || inj.api_path || null,
    unlock: inj.unlock || null,
    supportsImages: inj.supportsImages !== false,
    status: (hasProvider && hasModel) ? 'configured' : 'unconfigured',
  };
}

// 记忆某个供应商的工具 schema 兼容模式（写回 providers.json）
// 写完后通过 markProvidersDirty 通知 cache 失效。
export function rememberProviderToolSchemaCompat(providerId, mode = 'gemini') {
  try {
    const file = providersPath();
    const store = readJson(file) || { providers: [] };
    if (!Array.isArray(store.providers)) return false;
    const idx = store.providers.findIndex(p => p && p.id === providerId);
    if (idx < 0) return false;
    const p = store.providers[idx];
    p.capabilities = (p.capabilities && typeof p.capabilities === 'object') ? p.capabilities : {};
    if (p.capabilities.toolSchemaCompat === mode) return false;
    p.capabilities.toolSchemaCompat = mode;
    writeJsonAtomic(file, store);
    markProvidersDirty();
    return true;
  } catch (e) {
    console.warn(`[pool] remember tool schema compat failed: ${e.message}`);
    return false;
  }
}

function normalizeTargetUnlock(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  if (raw === 'codex') return 'codex';
  if (raw === 'claudeCode' || raw === 'claude-code' || raw === 'claude_code') return 'claudeCode';
  return { error: `未知解锁类型(${raw})` };
}

function normalizeTargetApiFormat(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return null;
  if (raw === 'auto') return null;
  if (raw === 'openai') return 'openai';
  if (raw === 'anthropic') return 'anthropic';
  if (raw === 'gemini') return { error: '聊天代理尚未接入 Gemini 原生协议；请使用 OpenAI/Anthropic 兼容入口或留空自动识别' };
  return { error: `未知目标协议(${raw})` };
}

function apiFormatForUnlock(kind) {
  if (kind === 'codex') return 'openai';
  if (kind === 'claudeCode') return 'anthropic';
  return null;
}

function providerUnlockEnabled(provider, kind) {
  const unlock = provider?.unlocks?.[kind];
  return !!(unlock && unlock.enabled !== false);
}

const targetKeyRotation = new Map();

function apiKeyForTarget(target, fallbackKey) {
  const keys = Array.isArray(target?.apiKeys || target?.api_keys)
    ? (target.apiKeys || target.api_keys).map(k => String(k || '').trim()).filter(Boolean)
    : [];
  if (!keys.length) return fallbackKey;
  const rotationKey = `${target.providerId || target.provider_id || ''}|${target.model || ''}`;
  const next = targetKeyRotation.get(rotationKey) || 0;
  targetKeyRotation.set(rotationKey, (next + 1) % keys.length);
  return keys[next % keys.length];
}

// 把一个 target {providerId, model, apiFormat, unlock?} 解析成实际连接信息。
// 供应商不存在或被禁用 → 返回 {error}。
export function resolveTarget(target, providers) {
  const p = providers.get(target.providerId);
  if (!p) return { error: `供应商不存在(${target.providerId})` };
  if (p.enabled === false) return { error: `供应商已禁用(${p.name})` };
  const targetUnlock = normalizeTargetUnlock(target.unlock);
  if (targetUnlock?.error) return { error: targetUnlock.error };
  const targetApiFormat = normalizeTargetApiFormat(target.apiFormat || target.api_format);
  if (targetApiFormat?.error) return { error: targetApiFormat.error };
  if (targetUnlock && !providerUnlockEnabled(p, targetUnlock)) {
    return { error: `目标要求${targetUnlock === 'codex' ? ' Codex' : ' Claude Code'} 解锁，但供应商「${p.name}」未开启该解锁` };
  }
  const unlockApiFormat = apiFormatForUnlock(targetUnlock);
  if (targetApiFormat && unlockApiFormat && targetApiFormat !== unlockApiFormat) {
    return { error: `目标协议 ${targetApiFormat} 与${targetUnlock === 'codex' ? ' Codex' : ' Claude Code'} 解锁不匹配` };
  }
  const host = (p.apiHost || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
  const explicitPath = target.apiPath || target.api_path || null;
  const unlockConfig = targetUnlock ? p.unlocks?.[targetUnlock] : null;
  const unlockWireApi = unlockConfig?.wireApi || unlockConfig?.wire_api || null;
  const providerPath = p.apiPath || p.api_path || null;
  const route = inferTargetRouteFormat({ targetApiFormat, unlockApiFormat, targetUnlock, explicitPath, providerPath, host });
  if (route?.error) return { error: route.error };
  const routeFormat = route.format;
  const configuredPath = (explicitPath || unlockWireApi || providerPath) && (explicitPath || unlockWireApi || providerPath) !== '/'
    ? (explicitPath || unlockWireApi || providerPath)
    : null;
  const apiPath = unlockWireApi && !explicitPath
    ? cleanApiPath(unlockWireApi)
    : (routeFormat === 'openai' ? normalizeOpenAIApiPath(host, configuredPath) : normalizeAnthropicApiPath(configuredPath));
  // wireApi=chat 时，上游只支持 Chat Completions，强制使用 /chat/completions 路径
  const finalApiPath = (p.wireApi === 'chat' && !explicitPath)
    ? apiPath.replace(/\/responses$/, '/chat/completions')
    : apiPath;
  const modelId = target.model || p.defaultModel;
  // 合并供应商级 + 模型级能力标记
  const supplierCaps = p.capabilities || {};
  const modelCaps = (p.modelCaps || {})[modelId] || {};
  const hasModelVision = Object.prototype.hasOwnProperty.call(modelCaps, 'vision');
  const hasModelTools = Object.prototype.hasOwnProperty.call(modelCaps, 'tools');
  const capabilities = {
    ...supplierCaps,
    // 模型级覆盖供应商级（vision/tools 是模型能力）。
    // Provider 级 vision=false 可能来自小图探测误判，不能作为图片请求硬拦截依据。
    vision: hasModelVision ? modelCaps.vision : true,
    tools: hasModelTools ? modelCaps.tools : supplierCaps.tools,
  };
  return {
    providerId: p.id,
    providerName: p.name,
    host,
    apiPath: finalApiPath,
    apiKey: apiKeyForTarget(target, p.apiKey),
    format: routeFormat,
    routeSource: route.source,
    authScheme: routeFormat === 'openai' || shouldUseAnthropicBearerAuth(host, apiPath) ? 'bearer' : 'x-api-key',
    model: modelId,
    capabilities,
    unlocks: p.unlocks || {},
    unlockKind: targetUnlock,
    wireApi: p.wireApi || '',
    codexChatReasoning: p.codexChatReasoning || null,
  };
}

// 自动更新模型能力标记（使用成功后自动标记）
// hasVision/hasTools 表示本次请求是否包含图片/工具
// 性能优化：合并 5s 内的多次标记为一次落盘，避免高频 IO。
const pendingCapsWrites = new Map(); // key: providerId/modelId -> {vision, tools, timer}
let capsFlushTimer = null;
const CAPS_FLUSH_DELAY_MS = 5000;

function scheduleFlushCaps() {
  if (capsFlushTimer) return;
  capsFlushTimer = setTimeout(() => {
    capsFlushTimer = null;
    const writes = Array.from(pendingCapsWrites.entries());
    pendingCapsWrites.clear();
    if (writes.length === 0) return;
    try {
      const file = providersPath();
      const store = readJson(file) || { providers: [] };
      if (!Array.isArray(store.providers)) return;
      let anyChanged = false;
      for (const [key, add] of writes) {
        const [providerId, modelId] = key.split('|');
        const idx = store.providers.findIndex(p => p && p.id === providerId);
        if (idx < 0) continue;
        const p = store.providers[idx];
        p.modelCaps = p.modelCaps || {};
        p.modelCaps[modelId] = p.modelCaps[modelId] || {};
        if (add.vision && p.modelCaps[modelId].vision !== true) {
          p.modelCaps[modelId].vision = true; anyChanged = true;
        }
        if (add.tools && p.modelCaps[modelId].tools !== true) {
          p.modelCaps[modelId].tools = true; anyChanged = true;
        }
      }
      if (anyChanged) {
        writeJsonAtomic(file, store);
        markProvidersDirty();
        console.log(`[pool] 批量更新 ${writes.length} 个模型能力标记`);
      }
    } catch (e) {
      console.warn(`[pool] batch update model capabilities failed: ${e.message}`);
    }
  }, CAPS_FLUSH_DELAY_MS);
}

export function updateModelCapabilities(providerId, modelId, hasVision, hasTools) {
  if (!providerId || !modelId) return false;
  const key = `${providerId}|${modelId}`;
  const cur = pendingCapsWrites.get(key) || { vision: false, tools: false };
  let changed = false;
  if (hasVision) { cur.vision = true; changed = true; }
  if (hasTools) { cur.tools = true; changed = true; }
  if (changed) {
    pendingCapsWrites.set(key, cur);
    scheduleFlushCaps();
  }
  return changed;
}
