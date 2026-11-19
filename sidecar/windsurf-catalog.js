// windsurf-catalog.js — Windsurf 模型全量目录（单一事实源：windsurf-catalog.json）

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function resolveCatalogPath() {
  const candidates = [];

  try {
    if (typeof import.meta !== 'undefined' && typeof import.meta.url === 'string' && import.meta.url) {
      const selfDir = path.dirname(fileURLToPath(import.meta.url));
      candidates.push(path.join(selfDir, 'windsurf-catalog.json'));
      candidates.push(path.join(selfDir, '..', 'windsurf-catalog.json'));
    }
  } catch {
    // esbuild CJS / bytenode 模式下 import.meta.url 可能不可用
  }

  // eslint-disable-next-line no-undef
  if (typeof __dirname === 'string' && __dirname) {
    // eslint-disable-next-line no-undef
    candidates.push(path.join(__dirname, 'windsurf-catalog.json'));
    // eslint-disable-next-line no-undef
    candidates.push(path.join(__dirname, '..', 'windsurf-catalog.json'));
  }

  const resDir = process.env.BYOK_RESOURCE_DIR;
  if (resDir) {
    candidates.push(path.join(resDir, 'sidecar', 'windsurf-catalog.json'));
    candidates.push(path.join(resDir, 'windsurf-catalog.json'));
  }

  if (process.execPath) {
    const execDir = path.dirname(process.execPath);
    candidates.push(path.join(execDir, 'windsurf-catalog.json'));
    candidates.push(path.join(execDir, 'sidecar', 'windsurf-catalog.json'));
  }

  const cwd = process.cwd();
  candidates.push(path.join(cwd, 'windsurf-catalog.json'));
  candidates.push(path.join(cwd, 'sidecar', 'windsurf-catalog.json'));

  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

export function loadWindsurfCatalog() {
  const catalogPath = resolveCatalogPath();
  if (!catalogPath) return [];
  try {
    const raw = fs.readFileSync(catalogPath, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed?.models) ? parsed.models : [];
  } catch {
    return [];
  }
}

export const WINDSURF_CATALOG = loadWindsurfCatalog();
