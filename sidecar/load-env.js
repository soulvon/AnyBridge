// load-env.js — Side-effect module: 加载杂项配置（MAX_TOKENS / 系统提示词等）到 process.env。
// 必须在任何 server 模块之前 import，使 handler 能读到这些变量。
//
// 供应商路由不再走 env：sidecar 直接读 providers.json（全部供应商）+ model-map.json
// 做按槽位故障转移（见 provider-pool.js）。「激活供应商」概念已废弃，此处不再处理它。

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

function readJson(file) {
  try {
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    console.error(`[entry] failed to read ${file}: ${e.message}`);
    return null;
  }
}

function setEnv(key, val) {
  if (val == null || val === '') return;
  process.env[key] = String(val);
}

function resolveSystemPromptPath(value, resourceDir) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (path.isAbsolute(raw)) return raw;

  const normalized = raw.replace(/\\/g, '/').replace(/^\.\//, '');
  if (normalized === 'prompts/system-prompt.md' && resourceDir) {
    return path.join(resourceDir, 'prompts', 'system-prompt.md');
  }
  if (normalized === 'prompts/system-prompt.md') {
    return path.resolve(process.cwd(), raw);
  }
  return path.resolve(configDir(), raw);
}

const dir = configDir();

// ─── 杂项配置（MAX_TOKENS / 系统提示词 / VOYAGE 等）────────
const cfg = readJson(path.join(dir, 'byok-config.json'));
if (cfg && cfg.values && typeof cfg.values === 'object') {
  for (const [key, val] of Object.entries(cfg.values)) {
    setEnv(key, val);
  }
}

if (process.env.SYSTEM_PROMPT_PATH) {
  process.env.SYSTEM_PROMPT_PATH = resolveSystemPromptPath(
    process.env.SYSTEM_PROMPT_PATH,
    process.env.BYOK_RESOURCE_DIR || ''
  );
}
