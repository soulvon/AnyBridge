// provider-pool.js — 读取 providers.json（全部供应商）+ model-map.json（槽位表），
// 为路由层提供:按 modelUid 查槽位、按 providerId 解析连接信息。
//
// 取代旧的「load-env 挑激活供应商写 env」方案:sidecar 直接读两份 JSON，
// 按槽位 targets 做故障转移，不再有「激活」概念。

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

function configDir() {
  if (process.env.BYOK_CONFIG_DIR) return process.env.BYOK_CONFIG_DIR;
  return path.join(os.homedir(), 'AppData', 'Roaming', 'windsurf-byok');
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

// 热加载:每次请求读最新文件（GUI 改了配置无需重启 sidecar）。配置文件很小，开销可忽略。
function loadProviders() {
  const store = readJson(path.join(configDir(), 'providers.json'));
  const list = (store && Array.isArray(store.providers)) ? store.providers : [];
  const map = new Map();
  for (const p of list) map.set(p.id, p);
  return map;
}

function loadSlots() {
  const m = readJson(path.join(configDir(), 'model-map.json'));
  const slots = (m && Array.isArray(m.slots)) ? m.slots : [];
  const map = new Map();
  for (const s of slots) map.set(s.modelUid, s);
  return map;
}

// 返回该 modelUid 对应的槽位（启用且有 targets 才算可劫持），否则 null。
export function getSlot(modelUid) {
  if (!modelUid) return null;
  const slot = loadSlots().get(modelUid);
  if (!slot || slot.enabled === false) return null;
  return slot;
}

// 把一个 target {providerId, model} 解析成实际连接信息。
// 供应商不存在或被禁用 → 返回 {error}。
export function resolveTarget(target, providers) {
  const p = providers.get(target.providerId);
  if (!p) return { error: `供应商不存在(${target.providerId})` };
  if (p.enabled === false) return { error: `供应商已禁用(${p.name})` };
  const isOpenAI = p.apiFormat === 'openai';
  const host = (p.apiHost || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
  return {
    providerName: p.name,
    host,
    apiPath: p.apiPath || (isOpenAI ? '/v1/responses' : '/v1/messages'),
    apiKey: p.apiKey,
    format: isOpenAI ? 'openai' : 'anthropic',
    model: target.model || p.defaultModel,
  };
}

export { loadProviders };
