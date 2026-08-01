// sidecar/plugin-loader.js
// Plugin loader for AnyBridge — loads plugin.json + adapter.js dynamically,
// injects ctx utilities, and exposes HTTP endpoints for the Rust core.

import { readFile, readdir, stat, mkdir, writeFile } from 'fs/promises';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';
import { exec } from 'child_process';
import crypto from 'crypto';
import { executeDeploy } from './step-executor.js';

// ── Resolve plugins directory ──
// Priority: ANYBRIDGE_PLUGINS_DIR (set by Rust on spawn)
//   → BYOK_RESOURCE_DIR/plugins (packaged) → BYOK_RESOURCE_DIR/resources/plugins (nested layout)
//   → <repo>/src-tauri/resources/plugins (dev, sidecar runs with cwd=<repo>/sidecar)
//   → cwd/plugins (last resort)
function resolvePluginsDir() {
  const candidates = [];
  if (process.env.ANYBRIDGE_PLUGINS_DIR) candidates.push(process.env.ANYBRIDGE_PLUGINS_DIR);
  const resDir = process.env.BYOK_RESOURCE_DIR;
  if (resDir) {
    candidates.push(join(resDir, 'plugins'));
    candidates.push(join(resDir, 'resources', 'plugins'));
  }
  try {
    const moduleDir = dirname(fileURLToPath(import.meta.url));
    candidates.push(join(moduleDir, '..', 'src-tauri', 'resources', 'plugins'));
  } catch { /* import.meta unavailable in bundled runtime */ }
  candidates.push(join(process.cwd(), 'plugins'));
  candidates.push(join(process.cwd(), '..', 'src-tauri', 'resources', 'plugins'));

  for (const c of candidates) {
    try { if (existsSync(c)) return resolve(c); } catch { /* ignore */ }
  }
  // Nothing found — return the first candidate so error messages stay meaningful
  return resolve(candidates[0]);
}

const PLUGINS_DIR = resolvePluginsDir();
const pluginCache = new Map(); // key: pluginId, value: { manifest, adapter, pluginDir, mtime }

// ── ctx: utilities injected into every adapter method call ──
const adapterContext = {
  commandExists: (name) => new Promise((resolve) => {
    const cmd = process.platform === 'win32' ? `where ${name}` : `which ${name}`;
    exec(cmd, { timeout: 5000 }, (err) => resolve(!err));
  }),
  fetch: globalThis.fetch,
  fs: await import('fs/promises'),
  path: await import('path'),
  exec: (cmd, options = {}) => new Promise((resolve, reject) => {
    const opts = { maxBuffer: 10 * 1024 * 1024, ...options };
    exec(cmd, opts, (error, stdout, stderr) => {
      if (error) reject(error); else resolve({ stdout, stderr });
    });
  }),
  log: (level, message) => console.log(JSON.stringify({ time: new Date().toISOString(), level, message })),
  generateHex: (length = 32) => crypto.randomBytes(Math.ceil(length / 2)).toString('hex').slice(0, length),
  generateBase64: (bytes = 32) => crypto.randomBytes(bytes).toString('base64'),
  generatePassword: (length = 20) => {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789!@#$%^&*';
    let pwd = '';
    const bytes = crypto.randomBytes(length);
    for (let i = 0; i < length; i++) pwd += chars[bytes[i] % chars.length];
    return pwd;
  }
};

// ── Load plugin (with cache + cache-busting) ──
async function loadPlugin(pluginId, { reload = false } = {}) {
  if (!reload && pluginCache.has(pluginId)) {
    const cached = pluginCache.get(pluginId);
    const jsonPath = join(PLUGINS_DIR, pluginId, 'plugin.json');
    try {
      const stats = await stat(jsonPath);
      if (stats.mtimeMs === cached.mtime) return cached;
    } catch { /* file changed or missing — reload */ }
  }

  const pluginDir = join(PLUGINS_DIR, pluginId);
  if (!existsSync(pluginDir)) throw new Error(`Plugin not found: ${pluginId}`);
  const jsonPath = join(pluginDir, 'plugin.json');
  const manifest = JSON.parse(await readFile(jsonPath, 'utf-8'));
  const jsonStats = await stat(jsonPath);

  const installerName = manifest.deploy?.source?.installer || manifest.deploy?.installer || 'adapter.js';
  const adapterPath = `file://${resolve(join(pluginDir, installerName))}`;
  // cache-busting query to avoid dynamic import caching stale module
  const adapter = (await import(`${adapterPath}?t=${jsonStats.mtimeMs}`)).default;

  const loaded = { manifest, adapter, pluginDir, mtime: jsonStats.mtimeMs };
  pluginCache.set(pluginId, loaded);
  return loaded;
}

// ── Call an adapter method with ctx injection ──
async function callAdapter(pluginId, method, args = []) {
  const { adapter, pluginDir } = await loadPlugin(pluginId);
  if (typeof adapter[method] !== 'function') {
    throw new Error(`Adapter method "${method}" not implemented for plugin "${pluginId}"`);
  }
  const ctx = { ...adapterContext, pluginDir };
  return adapter[method](ctx, ...args);
}

// ── List all available plugins ──
async function listPlugins() {
  let entries;
  try {
    entries = await readdir(PLUGINS_DIR, { withFileTypes: true });
  } catch (e) {
    // Plugins directory missing (fresh install / packaging issue) — return empty, not an error
    return [];
  }
  const plugins = [];
  for (const entry of entries) {
    if (entry.isDirectory() && !entry.name.startsWith('_') && !entry.name.startsWith('.')) {
      try {
        plugins.push(JSON.parse(await readFile(join(PLUGINS_DIR, entry.name, 'plugin.json'), 'utf-8')));
      } catch (e) { /* skip invalid plugin */ }
    }
  }
  return plugins;
}

// ── HTTP server for Rust core to call ──
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => data += chunk);
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

// ── Deploy a plugin with the given strategy ──
// Runs deploy.md steps, then generates the config file via adapter.generateConfig().
async function runDeploy(body, onStreamProgress) {
  const { pluginId, strategy, installPath, configValues = {} } = body;
  const loaded = await loadPlugin(pluginId);

  const deployDoc = loaded.manifest.deploy?.[strategy]?.doc || 'deploy.md';
  const deployMdPath = join(loaded.pluginDir, deployDoc);
  const deployMdContent = await readFile(deployMdPath, 'utf-8');

  // Fill in secrets declared by configSchema (config file is written AFTER the build steps)
  const configWithSecrets = { ...configValues, port: configValues.port || 8000 };
  for (const field of loaded.manifest.configSchema || []) {
    if (!field.generate || configWithSecrets[field.key]) continue;
    if (field.generate === 'hex-32') configWithSecrets[field.key] = adapterContext.generateHex(32);
    else if (field.generate === 'base64-32') configWithSecrets[field.key] = adapterContext.generateBase64(32);
    else if (field.generate === 'random-password') configWithSecrets[field.key] = adapterContext.generatePassword(20);
  }
  configWithSecrets._deployStrategy = strategy;

  const progressEvents = [];
  const onProgress = (evt) => {
    progressEvents.push(evt);
    onStreamProgress?.({ type: 'progress', ...evt });
  };

  const result = await executeDeploy({
    pluginId,
    strategy,
    deployMdContent,
    installPath,
    configValues: configWithSecrets,
    onProgress,
  });

  if (!result.success) {
    return { ok: false, result: { ...result, progress: progressEvents } };
  }

  // Post-step: generate the config file via adapter (corresponds to deploy.md "Config" step)
  onProgress({ step: 'config', title: 'Generate Config', status: 'running', message: '生成配置文件...' });

  let configPath = null;
  try {
    const configResult = await callAdapter(pluginId, 'generateConfig', [configWithSecrets, installPath]);
    configPath = configResult?.configPath || null;
    onProgress({ step: 'config', title: 'Generate Config', status: 'done', message: '配置文件已生成' });
  } catch (e) {
    onProgress({ step: 'config', title: 'Generate Config', status: 'error', message: `generateConfig 失败: ${e.message}` });
    return { ok: false, error: `generateConfig failed: ${e.message}`, result: { ...result, progress: progressEvents } };
  }

  // Persist deployed config alongside the install for recovery/debugging
  try {
    await writeFile(
      join(installPath, '.anybridge-plugin-config.json'),
      JSON.stringify({ ...configWithSecrets, installPath, configPath, deployedAt: new Date().toISOString() }, null, 2),
      'utf-8'
    );
  } catch { /* non-fatal */ }

  return {
    ok: true,
    result: { ...result, configPath, configValues: configWithSecrets, progress: progressEvents },
  };
}

// ── HTTP routes for the Rust core. Always returns a Promise<boolean> (handled or not). ──
async function attachPluginRoutes(req, res, url, body) {
  // GET /internal/plugins/list
  if (url.pathname === '/internal/plugins/list' && req.method === 'GET') {
    res.end(JSON.stringify({ ok: true, plugins: await listPlugins(), pluginsDir: PLUGINS_DIR }));
    return true;
  }

  if (req.method !== 'POST') return false;

  // POST /internal/plugins/load
  if (url.pathname === '/internal/plugins/load') {
    const loaded = await loadPlugin(body.pluginId);
    res.end(JSON.stringify({ ok: true, manifest: loaded.manifest }));
    return true;
  }

  // POST /internal/plugins/call
  if (url.pathname === '/internal/plugins/call') {
    const result = await callAdapter(body.pluginId, body.method, body.args || []);
    res.end(JSON.stringify({ ok: true, result }));
    return true;
  }

  // POST /internal/plugins/check-environment — Body: { pluginId, strategy? }
  if (url.pathname === '/internal/plugins/check-environment') {
    const result = await callAdapter(body.pluginId, 'checkEnvironment', [body.strategy || 'source']);
    res.end(JSON.stringify({ ok: true, result }));
    return true;
  }

  // POST /internal/plugins/deploy — Body: { pluginId, strategy, installPath, configValues }
  // Returns NDJSON stream: one JSON object per line, flushed in real-time.
  // Each line is either { type: 'progress', ...event } or { type: 'result', ok, result/error }.
  if (url.pathname === '/internal/plugins/deploy') {
    res.setHeader('content-type', 'application/x-ndjson');
    res.setHeader('cache-control', 'no-cache');
    res.setHeader('x-accel-buffering', 'no');
    res.flushHeaders?.();

    const sendLine = (obj) => {
      res.write(JSON.stringify(obj) + '\n');
    };

    try {
      const result = await runDeploy(body, sendLine);
      sendLine({ type: 'result', ...result });
    } catch (err) {
      sendLine({ type: 'result', ok: false, error: err.message });
    }
    res.end();
    return true;
  }

  return false;
}

export { loadPlugin, callAdapter, listPlugins, attachPluginRoutes, adapterContext, PLUGINS_DIR };
