// codex-home.js
// 与 Rust codex_home() 对齐：优先 CODEX_HOME，否则 ~/.codex

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const CODEX_MODEL_CATALOG_FILENAME = 'anybridge-model-catalog.json';

/**
 * @returns {string} Codex 配置目录绝对路径
 */
export function codexHome() {
  const raw = process.env.CODEX_HOME;
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (trimmed) return path.resolve(trimmed);
  }
  return path.join(os.homedir(), '.codex');
}

/**
 * @param {...string} segments
 * @returns {string}
 */
export function codexPath(...segments) {
  return path.join(codexHome(), ...segments);
}

/**
 * @returns {string}
 */
export function codexAuthJsonPath() {
  return codexPath('auth.json');
}

/**
 * @returns {string}
 */
export function codexModelCatalogPath() {
  return codexPath(CODEX_MODEL_CATALOG_FILENAME);
}

/**
 * 读取 AnyBridge catalog 中的可注入模型列表。
 * 文件缺失时抛错（catalog 由 Rust 在切换供应商 / write_models_cache 时写入）。
 * @returns {Array<object>}
 */
export function readInjectableModels() {
  const catalogFile = codexModelCatalogPath();
  if (!fs.existsSync(catalogFile)) {
    throw new Error(`Codex model catalog not found: ${catalogFile}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(catalogFile, 'utf8'));
  } catch (err) {
    throw new Error(`Failed to parse Codex model catalog ${catalogFile}: ${err.message || err}`);
  }
  const arr = Array.isArray(parsed)
    ? parsed
    : (parsed && Array.isArray(parsed.models) ? parsed.models : null);
  if (!Array.isArray(arr)) {
    throw new Error(`Codex model catalog has no models array: ${catalogFile}`);
  }
  const models = arr.filter((m) => m && (m.slug || m.model));
  if (!models.length) {
    throw new Error(`Codex model catalog has no injectable models: ${catalogFile}`);
  }
  return models;
}
