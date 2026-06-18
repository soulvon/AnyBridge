// config-cache.js — 进程内缓存 providers.json / model-map.json，消除同步读盘抖动
//
// 设计目标：
//   1. loadProviders() / loadSlots() 在每个 GetChatMessage 上被多次调用，
//      原实现每次 readFileSync + JSON.parse，Windows 上单次 1-5ms，
//      高并发下直接成为瓶颈。
//   2. 文件变更时（GUI 改了配置）需要能感知。使用 mtime 检测，TTL 兜底。
//   3. 同时提供"轻量 invalidate"接口供写入方主动通知。
//
// 接口：
//   getProviders()  -> Map<id, provider>
//   getSlots()      -> Map<modelUid, {kind, data}>
//   invalidate('providers' | 'slots' | 'all')
//   markProvidersDirty()  // 写入方调用

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

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

const PROVIDERS_PATH = () => path.join(configDir(), 'providers.json');
const SLOTS_PATH = () => path.join(configDir(), 'model-map.json');

const TTL_MS = 2000; // 兜底 TTL：2s 内不重新读盘（即便 mtime 变化）

const cache = {
  providers: { mtimeMs: 0, data: null, loadedAt: 0, dirty: true },
  slots:     { mtimeMs: 0, data: null, loadedAt: 0, dirty: true },
};

function readJsonSafe(file) {
  try {
    if (!fs.existsSync(file)) return null;
    const stat = fs.statSync(file);
    const raw = fs.readFileSync(file, 'utf8');
    return { stat, json: JSON.parse(raw) };
  } catch (e) {
    console.error(`[config-cache] failed to read ${file}: ${e.message}`);
    return null;
  }
}

function loadEntry(entry, file, transform) {
  const now = Date.now();
  if (!entry.dirty && (now - entry.loadedAt) < TTL_MS && entry.data) return entry.data;
  const r = readJsonSafe(file);
  if (!r) {
    entry.mtimeMs = 0;
    entry.loadedAt = now;
    entry.data = transform ? transform(null) : null;
    entry.dirty = false;
    return entry.data;
  }
  // mtime 命中 + 未过期 → 跳过 parse
  if (entry.data && r.stat.mtimeMs === entry.mtimeMs) {
    entry.loadedAt = now;
    entry.dirty = false;
    return entry.data;
  }
  entry.mtimeMs = r.stat.mtimeMs;
  entry.loadedAt = now;
  entry.data = transform ? transform(r.json) : r.json;
  entry.dirty = false;
  return entry.data;
}

function transformProviders(json) {
  const list = (json && Array.isArray(json.providers)) ? json.providers : [];
  const m = new Map();
  for (const p of list) {
    if (p && p.id) m.set(p.id, p);
  }
  return m;
}

function transformSlots(json) {
  const slots = (json && Array.isArray(json.slots)) ? json.slots : [];
  const injected = (json && Array.isArray(json.injected)) ? json.injected : [];
  const m = new Map();
  for (const s of slots) {
    if (s && s.modelUid) m.set(s.modelUid, { kind: 'slot', data: s });
  }
  for (const i of injected) {
    if (i && i.modelUid) m.set(i.modelUid, { kind: 'injected', data: i });
  }
  return m;
}

export function getProviders() {
  return loadEntry(cache.providers, PROVIDERS_PATH(), transformProviders);
}

export function getSlots() {
  return loadEntry(cache.slots, SLOTS_PATH(), transformSlots);
}

export function invalidate(what = 'all') {
  if (what === 'all' || what === 'providers') cache.providers.dirty = true;
  if (what === 'all' || what === 'slots') cache.slots.dirty = true;
}

export function markProvidersDirty() { cache.providers.dirty = true; }
export function markSlotsDirty() { cache.slots.dirty = true; }
