#!/usr/bin/env node
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DEFAULT_SANDBOX_DIR, REPO_ROOT, seedSandbox } from './sandbox/seed-sandbox.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const BRIDGE_SCRIPT_PATH = path.join(__dirname, 'sandbox', 'sandbox-bridge.js');
const UI_ROOT = path.join(REPO_ROOT, 'ui');
const PLUGINS_RES_ROOT = path.join(REPO_ROOT, 'src-tauri', 'resources', 'plugins');
const WINDSURF_CATALOG_PATH = path.join(REPO_ROOT, 'sidecar', 'windsurf-catalog.json');
const PACKAGE_JSON_PATH = path.join(REPO_ROOT, 'package.json');

const MIME_MAP = {
  '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
};

const NOOP_NULL_CMDS = new Set([
  'update_last_check_time', 'mark_check_failed', 'update_log', 'open_url', 'open_download_page',
  'open_config_dir', 'reveal_path', 'pick_directory', 'pick_file', 'export_proxy_logs',
  'download_and_install_update', 'restart_app', 'restart_ide', 'restart_antigravity_ide_with_cdp',
  'set_ide_path', 'set_windsurf_path', 'check_version_jump', 'check_for_update',
]);

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

async function resolvePortOption(value, fallback) {
  if (value === 0) return getFreePort();
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function isLoopbackHttpUrl(rawHost) {
  return /^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?(?:\/|$)/i.test(String(rawHost || '').trim());
}

function parseCliArgs(argv) {
  const opts = {
    port: 17480, sandboxDir: DEFAULT_SANDBOX_DIR, reseed: false, sidecar: true,
    apiPort: null, inferencePort: null, agHttpsPort: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port' && argv[i + 1] !== undefined) opts.port = Number(argv[++i]);
    else if (a === '--api-port' && argv[i + 1] !== undefined) opts.apiPort = Number(argv[++i]);
    else if (a === '--inference-port' && argv[i + 1] !== undefined) opts.inferencePort = Number(argv[++i]);
    else if (a === '--ag-https-port' && argv[i + 1] !== undefined) opts.agHttpsPort = Number(argv[++i]);
    else if (a === '--sandbox-dir' && argv[i + 1]) opts.sandboxDir = path.resolve(argv[++i]);
    else if (a === '--reseed') opts.reseed = true;
    else if (a === '--no-sidecar') opts.sidecar = false;
  }
  if (!Number.isFinite(opts.port) || opts.port < 0) opts.port = 17480;
  return opts;
}

function readJson(filePath, fallback = {}) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { return fallback; }
}

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

function loadPluginManifests(state) {
  const runtimeStates = state.extensions?.pluginRuntimeStates || {};
  const list = [];
  if (!fs.existsSync(PLUGINS_RES_ROOT)) return list;
  for (const entry of fs.readdirSync(PLUGINS_RES_ROOT, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifestPath = path.join(PLUGINS_RES_ROOT, entry.name, 'plugin.json');
    if (!fs.existsSync(manifestPath)) continue;
    const manifest = readJson(manifestPath, null);
    if (!manifest?.id) continue;
    const st = runtimeStates[manifest.id] || {};
    const stateStr = st.running ? 'running' : (st.installed ? 'stopped' : 'not-installed');
    list.push({
      manifest,
      status: {
        state: stateStr,
        installed: Boolean(st.installed), running: Boolean(st.running),
        port: st.port || manifest.defaultPort || 18400, version: st.version || manifest.version || '1.0.0',
        health: st.health || (st.running ? 'healthy' : 'stopped'), error: null,
        installDir: st.installDir || path.join(path.dirname(PLUGINS_RES_ROOT), entry.name),
      },
    });
  }
  return list;
}

function resolveLoopbackChatPath(fmt, rawPath) {
  const clean = String(rawPath || '').trim();
  if (fmt === 'gemini') {
    if (!clean || clean === '/' || clean === '/v1beta') return '/v1beta/models/gemini-2.5-flash:generateContent';
    return clean.startsWith('/') ? clean : `/${clean}`;
  }
  if (fmt === 'anthropic') {
    if (!clean || clean === '/' || clean === '/v1') return '/v1/messages';
    return clean.endsWith('/messages') ? clean : `${clean.replace(/\/+$/, '')}/messages`;
  }
  if (!clean || clean === '/' || clean === '/v1') return '/v1/chat/completions';
  if (clean.endsWith('/chat/completions') || clean.endsWith('/responses')) return clean;
  return `${clean.replace(/\/+$/, '')}/chat/completions`;
}

function loopbackAuthHeaders(fmt, apiKey, urlObj) {
  const key = String(apiKey || '').trim();
  if (fmt === 'anthropic') {
    return { 'x-api-key': key, 'anthropic-version': '2023-06-01' };
  }
  if (fmt === 'gemini') {
    if (key) urlObj.searchParams.set('key', key);
    return key ? { 'x-goog-api-key': key } : {};
  }
  return { authorization: `Bearer ${key}` };
}

async function probeLoopbackConnection(reqArgs = {}) {
  const rawHost = String(reqArgs.host || '').trim().replace(/\/+$/, '');
  const fmt = String(reqArgs.api_format || 'openai').trim().toLowerCase();
  const chatPath = resolveLoopbackChatPath(fmt, reqArgs.path);
  const urlObj = new URL(`${rawHost}${chatPath}`);
  const headers = { 'content-type': 'application/json', ...loopbackAuthHeaders(fmt, reqArgs.api_key, urlObj) };
  const model = String(reqArgs.model || '').trim() || 'gpt-4.1';
  const bodyObj = fmt === 'gemini'
    ? { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] }
    : (chatPath.endsWith('/responses')
      ? { model, input: [{ role: 'user', content: 'hi' }], max_output_tokens: 16, stream: false }
      : { model, messages: [{ role: 'user', content: 'hi' }], max_tokens: 16, stream: false });
  const started = Date.now();
  const resp = await fetch(urlObj, {
    method: 'POST', headers, body: JSON.stringify(bodyObj), signal: AbortSignal.timeout(6000),
  });
  const latencyMs = Math.max(1, Date.now() - started);
  const text = await resp.text();
  if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${text.slice(0, 180) || resp.statusText}`);
  return {
    ok: true,
    message: `HTTP ${resp.status} (${latencyMs}ms)`,
    latency_ms: latencyMs,
    latencyMs,
    capabilities: { gzip: false, vision: true, tools: true },
  };
}

async function fetchLoopbackModels(reqArgs = {}) {
  const rawHost = String(reqArgs.host || '').trim().replace(/\/+$/, '');
  const fmt = String(reqArgs.api_format || 'openai').trim().toLowerCase();
  const candidates = fmt === 'gemini' ? ['/v1beta/models', '/v1/models'] : ['/v1/models', '/models'];
  let lastErr = '';
  for (const cand of candidates) {
    const urlObj = new URL(`${rawHost}${cand}`);
    const headers = { accept: 'application/json', ...loopbackAuthHeaders(fmt, reqArgs.api_key, urlObj) };
    const resp = await fetch(urlObj, { method: 'GET', headers, signal: AbortSignal.timeout(6000) });
    const text = await resp.text();
    if (!resp.ok) {
      lastErr = `${cand}: HTTP ${resp.status} ${text.slice(0, 120)}`;
      continue;
    }
    const json = text ? JSON.parse(text) : {};
    const list = Array.isArray(json.data)
      ? json.data.map((x) => String(x?.id || x || '').replace(/^models\//, '')).filter(Boolean)
      : (Array.isArray(json.models)
        ? json.models.map((x) => String(x?.name || x?.id || x || '').replace(/^models\//, '')).filter(Boolean)
        : []);
    if (list.length > 0) return { models: list, api_format: fmt };
  }
  throw new Error(lastErr || '模型列表拉取失败：返回列表为空');
}

function createInvokeRouter({ sandboxDir, configDir, sidecarHandle, ports }) {
  const cfgFile = (name) => path.join(configDir, name);
  const readCfg = () => readJson(cfgFile('byok-config.json'), { values: {} });
  const readProviders = () => readJson(cfgFile('providers.json'), { providers: [] });
  const readState = () => readJson(cfgFile('sandbox-mock-state.json'), {});
  const writeState = (s) => writeJson(cfgFile('sandbox-mock-state.json'), s);
  const appVer = () => String(readJson(PACKAGE_JSON_PATH, { version: '1.1.13' }).version || '1.1.13');

  const updatePlatform = (platformId, patch) => {
    const state = readState();
    const target = (state.platforms || []).find((p) => p.id === platformId);
    if (target) Object.assign(target, patch);
    writeState(state);
    return target;
  };

  const formatPlatformConfigText = (platformId) => {
    const store = readProviders();
    const state = readState();
    const plat = (state.platforms || []).find((p) => p.id === platformId);
    const activeId = plat?.currentProviderId || store.platforms?.[platformId]?.activeProviderId;
    const prov = (store.providers || []).find((p) => p.id === activeId) || store.providers?.[0];
    if (platformId === 'codex') {
      return `model = "${prov?.defaultModel || 'o4-mini'}"\nmodel_provider = "anybridge"\n[model_providers.anybridge]\nbase_url = "${prov?.apiHost || 'https://api.openai.com'}/v1"\n`;
    }
    return JSON.stringify({
      platform: platformId, managedByAnyBridge: Boolean(plat?.managedByAnyBridge),
      provider: prov?.name || 'Anthropic Claude', apiHost: prov?.apiHost || 'https://api.anthropic.com',
      defaultModel: prov?.defaultModel || 'claude-sonnet-4-20250514',
    }, null, 2);
  };

  const managedPlatformKey = (cmd) => (
    cmd.includes('pi_models') ? 'pi' : cmd.includes('hermes_models') ? 'hermes' : cmd.includes('deepseek_harness_models') ? 'deepseek-harness' : 'codebuddy'
  );

  function handleCursor(cmd, args) {
    const store = readJson(cfgFile('cursor-models.json'), { models: [] });
    const routes = readJson(cfgFile('proxy-routes.json'), { routes: [] }).routes || [];
    const provs = readProviders().providers || [];
    const state = readState();
    if (cmd === 'cursor_get_status') {
      const c = state.cursor || {};
      const models = store.models || [];
      return {
        result: {
          running: c.running !== false, controlPort: c.controlPort || 17650, healthUrl: c.healthUrl || 'http://127.0.0.1:17650/health',
          configuredModels: models.length, syncedModels: models.filter((m) => m.enabled).length,
          configRevision: store.revision || 'sandbox-rev', coreRevision: store.revision || 'sandbox-rev',
          syncState: 'synced', lastSyncAt: new Date().toISOString(), lastSyncError: null,
          certificateReady: c.certificateReady !== false, certificateMessage: c.certificateMessage || '沙箱证书就绪',
          availableActions: [], lastError: null, migrationNotice: store.migrationNotice || null,
        },
      };
    }
    if (cmd === 'cursor_list_models') {
      return {
        result: (store.models || []).map((m) => {
          const r = routes.find((x) => x.uid === m.routeUid) || {};
          const target = r.targets?.[0] || {};
          const p = provs.find((x) => x.id === target.providerId) || provs[0] || {};
          return {
            ...m, providerId: target.providerId || p.id || '', providerName: p.name || 'Sandbox Provider',
            upstreamModel: target.model || m.exposedModelId,
            capabilities: r.capabilities || { stream: true, tools: true, vision: true, reasoning: true },
            overrides: m.cursorOverrides || {}, routeMissing: false,
          };
        }),
      };
    }
    if (cmd === 'cursor_list_provider_models') {
      const addedMap = new Map((store.models || []).map((m) => [m.exposedModelId, m.id]));
      return {
        result: provs.map((p) => ({
          providerId: p.id, providerName: p.name,
          models: (p.modelCatalog || []).map((m) => ({ ...m, alreadyAdded: addedMap.has(m.id), bindingId: addedMap.get(m.id) || null })),
        })),
      };
    }
    if (cmd === 'cursor_get_provider_tag_style') {
      return { result: { style: store.providerTagStyle || 'badge', bracketLeft: store.providerBracketLeft || '[', bracketRight: store.providerBracketRight || ']' } };
    }
    if (cmd === 'cursor_set_provider_tag_style') {
      store.providerTagStyle = args.style || 'badge';
      if (args.bracketLeft !== undefined) store.providerBracketLeft = args.bracketLeft;
      if (args.bracketRight !== undefined) store.providerBracketRight = args.bracketRight;
      writeJson(cfgFile('cursor-models.json'), store);
      return { result: { ok: true, style: store.providerTagStyle } };
    }
    if (cmd === 'cursor_add_models') {
      let nextOrder = (store.models?.length || 0) + 1;
      for (const item of args.req?.models || []) {
        const modelId = item.model || item.id || item.exposedModelId;
        if (modelId) {
          store.models.push({ id: `cursor-${Date.now()}-${nextOrder}`, routeUid: item.routeUid || `rt-${modelId}`, displayName: item.displayName || modelId, exposedModelId: modelId, enabled: true, sortOrder: nextOrder++, capabilityPolicy: 'auto', capabilityOverrides: {}, cursorOverrides: {}, useThirdPartyVision: Boolean(item.useThirdPartyVision) });
        }
      }
      writeJson(cfgFile('cursor-models.json'), store);
      return { result: { ok: true, count: store.models.length } };
    }
    if (cmd === 'cursor_update_model') {
      const item = (store.models || []).find((m) => m.id === args.payload?.id);
      if (item) Object.assign(item, args.payload);
      writeJson(cfgFile('cursor-models.json'), store);
      return { result: { ok: true } };
    }
    if (cmd === 'cursor_remove_models') {
      const removeSet = new Set(args.ids || []);
      store.models = (store.models || []).filter((m) => !removeSet.has(m.id));
      writeJson(cfgFile('cursor-models.json'), store);
      return { result: { ok: true } };
    }
    if (cmd === 'cursor_set_models_enabled' || cmd === 'cursor_set_models_third_party_vision') {
      const set = new Set(args.ids || []);
      const field = cmd === 'cursor_set_models_enabled' ? 'enabled' : 'useThirdPartyVision';
      for (const m of store.models || []) if (set.has(m.id)) m[field] = Boolean(args.enabled);
      writeJson(cfgFile('cursor-models.json'), store);
      return { result: { ok: true } };
    }
    if (cmd === 'cursor_enable' || cmd === 'cursor_disable' || cmd === 'cursor_restart') {
      state.cursor = state.cursor || {};
      state.cursor.running = cmd !== 'cursor_disable';
      writeState(state);
      return { result: { ok: true, running: state.cursor.running }, events: [{ name: 'cursor-core-status', payload: { running: state.cursor.running } }] };
    }
    return { result: { ok: true, checks: [{ name: 'sandbox', ok: true, message: 'Cursor 沙箱检查通过' }] } };
  }

  function handleExtensionsAndPlugins(cmd, args) {
    const state = readState();
    const ext = state.extensions || {};
    if (cmd === 'extension_list_managed_services') return { result: ext.services || [] };
    if (cmd === 'extension_cpa_default_install_dir' || cmd === 'extension_cpa_install_dir') return { result: ext.cpaInstallDir || path.join(sandboxDir, 'extensions', 'cpa-suite') };
    if (cmd === 'extension_set_cpa_install_dir') { ext.cpaInstallDir = String(args.dir || ''); writeState(state); return { result: ext.cpaInstallDir }; }
    if (cmd === 'extension_cpa_auto_start') return { result: Boolean(ext.cpaAutoStart) };
    if (cmd === 'extension_set_cpa_auto_start') { ext.cpaAutoStart = Boolean(args.enabled); writeState(state); return { result: ext.cpaAutoStart }; }
    if (cmd === 'extension_cpa_proxy_settings') return { result: ext.cpaProxySettings || { mode: 'system', customUrl: '' } };
    if (cmd === 'extension_set_cpa_proxy_settings') { ext.cpaProxySettings = { mode: args.mode || 'system', customUrl: args.customUrl || '' }; writeState(state); return { result: ext.cpaProxySettings }; }
    if (cmd === 'extension_check_cpa_updates') {
      return { result: { components: [{ id: 'cli-proxy-api', name: 'CLIProxyAPI', currentVersion: 'v6.8.14', latestVersion: 'v6.8.14', updateAvailable: false }, { id: 'cpa-manager-plus', name: 'CPA Manager Plus', currentVersion: 'v2.4.0', latestVersion: 'v2.4.0', updateAvailable: false }] } };
    }
    if (cmd === 'extension_list_cpa_versions') {
      return { result: { components: [{ id: 'cli-proxy-api', currentVersion: 'v6.8.14', versions: [{ version: 'v6.8.14', tag: 'v6.8.14' }, { version: 'v6.8.12', tag: 'v6.8.12' }] }, { id: 'cpa-manager-plus', currentVersion: 'v2.4.0', versions: [{ version: 'v2.4.0', tag: 'v2.4.0' }] }] } };
    }
    if (cmd === 'extension_list_mirrors' || cmd === 'extension_speed_test_mirrors') return { result: ext.mirrors || [] };
    if (cmd === 'extension_save_mirrors') { ext.mirrors = args.mirrors || ext.mirrors; writeState(state); return { result: ext.mirrors }; }
    if (cmd.startsWith('extension_')) {
      const svc = (ext.services || [])[0];
      if (svc) {
        svc.status = cmd.includes('stop') ? 'installed' : cmd.includes('uninstall') ? 'not-installed' : 'running';
        svc.installed = svc.status !== 'not-installed';
        svc.components?.forEach((c) => { c.status = svc.status === 'running' ? 'running' : 'stopped'; });
        writeState(state);
      }
      return { result: { ok: true, status: svc?.status || 'running' } };
    }
    const plugins = loadPluginManifests(state);
    if (cmd === 'plugin_list') return { result: plugins };
    if (cmd === 'plugin_get_manifest') return { result: plugins.find((p) => p.manifest.id === args.pluginId)?.manifest || null };
    if (cmd === 'plugin_get_status') return { result: plugins.find((p) => p.manifest.id === args.pluginId)?.status || { installed: false, running: false } };
    if (cmd === 'plugin_get_config') return { result: state.pluginConfigs?.[args.pluginId] || {} };
    if (cmd === 'plugin_set_config') {
      state.pluginConfigs = state.pluginConfigs || {};
      state.pluginConfigs[args.pluginId] = args.config || args.values || {};
      writeState(state);
      return { result: { ok: true } };
    }
    if (['plugin_start', 'plugin_stop', 'plugin_restart', 'plugin_deploy', 'plugin_uninstall'].includes(cmd)) {
      ext.pluginRuntimeStates = ext.pluginRuntimeStates || {};
      const st = ext.pluginRuntimeStates[args.pluginId] || { installed: true, running: false, port: 18400, version: '1.0.0' };
      st.running = cmd !== 'plugin_stop' && cmd !== 'plugin_uninstall';
      st.installed = cmd !== 'plugin_uninstall';
      st.health = st.running ? 'healthy' : 'stopped';
      ext.pluginRuntimeStates[args.pluginId] = st;
      writeState(state);
      return { result: { ok: true, status: st } };
    }
    if (cmd === 'plugin_read_logs') return { result: ['[sandbox] 插件服务运行中，健康探针 200 OK'] };
    if (cmd === 'plugin_check_environment') return { result: { ok: true, runtime: 'node', missing: [] } };
    if (cmd === 'plugin_check_update') return { result: { updateAvailable: false, currentVersion: '1.4.2', latestVersion: '1.4.2' } };
    return { result: { ok: true, healthy: true } };
  }

  return async function invoke(cmd, args = {}) {
    if (cmd === 'load_config') return { result: readCfg().values || {} };
    if (cmd === 'save_config') {
      const cfg = readCfg();
      cfg.values = { ...(cfg.values || {}), ...(args.values || {}) };
      writeJson(cfgFile('byok-config.json'), cfg);
      return { result: null };
    }
    if (cmd === 'load_providers') return { result: readProviders() };
    if (cmd === 'save_providers') { writeJson(cfgFile('providers.json'), args.store || readProviders()); return { result: null }; }
    if (cmd === 'set_provider_enabled') {
      const store = readProviders();
      const target = (store.providers || []).find((p) => p.id === args.id);
      if (target) target.enabled = Boolean(args.enabled);
      writeJson(cfgFile('providers.json'), store);
      return { result: null };
    }
    if (cmd === 'set_provider_unlock') {
      const store = readProviders();
      const target = (store.providers || []).find((p) => p.id === args.providerId);
      if (target) {
        target.unlocks = target.unlocks && typeof target.unlocks === 'object' ? target.unlocks : {};
        target.unlocks[args.kind] = {
          ...(typeof target.unlocks[args.kind] === 'object' && target.unlocks[args.kind] ? target.unlocks[args.kind] : {}),
          enabled: Boolean(args.enabled),
          unlockedAt: new Date().toISOString(),
          wireApi: args.kind === 'codex' ? '/responses' : '/messages',
        };
      }
      writeJson(cfgFile('providers.json'), store);
      return { result: target || null };
    }
    if (cmd === 'test_connection') {
      const reqArgs = args.args || args || {};
      if (isLoopbackHttpUrl(reqArgs.host)) {
        return { result: await probeLoopbackConnection(reqArgs) };
      }
      return { result: { ok: true, message: '沙箱连接测试通过 (HTTP 200)', latency_ms: 146, latencyMs: 146, capabilities: { gzip: true, vision: true, tools: true } } };
    }
    if (cmd === 'test_vision') return { result: { ok: true, supported: true, latencyMs: 280, message: '图像理解测试通过（沙箱模拟）' } };
    if (cmd === 'query_provider_balance') {
      const prov = (readProviders().providers || []).find((p) => p.apiHost === args.host || p.apiKey === args.api_key);
      return { result: prov?.balance || { ok: true, mode: 'usd', unit: 'USD', total: 100, used: 15, remaining: 85, unlimited: false, message: '$85.00 沙箱余额', latencyMs: 112 } };
    }
    if (cmd === 'fetch_models') {
      const reqArgs = args.args || args || {};
      if (isLoopbackHttpUrl(reqArgs.host)) {
        return { result: await fetchLoopbackModels(reqArgs) };
      }
      const prov = (readProviders().providers || []).find((p) => p.apiHost === reqArgs.host);
      return { result: { models: prov?.models || ['gpt-4.1', 'claude-sonnet-4-20250514', 'gemini-2.5-pro'], api_format: reqArgs.api_format || prov?.apiFormat || 'openai' } };
    }
    if (cmd === 'scan_importable_providers' || cmd === 'start_provider_import_scan') return { result: { scanId: 'sandbox-scan', candidates: [] } };
    if (cmd === 'cancel_provider_import_scan' || cmd === 'import_providers') return { result: { imported: (args.candidates || []).length } };

    if (cmd === 'list_eval_reports') return { result: readState().evalReports || [] };
    if (cmd === 'run_provider_eval') {
      const state = readState();
      const req = args.request || {};
      const prov = (readProviders().providers || []).find((p) => p.id === req.providerId);
      const report = {
        id: `eval-sb-${Date.now()}`, createdAt: new Date().toISOString(),
        providerId: req.providerId || 'prov-openai-direct', providerName: prov?.name || 'Sandbox Provider',
        apiFormat: req.apiFormat || prov?.apiFormat || 'openai', model: req.model || prov?.defaultModel || 'gpt-4.1',
        reportedModel: req.model || prov?.defaultModel || 'gpt-4.1', mode: req.mode || 'quick',
        score: 95, riskLevel: 'low', verdict: '沙箱多维探针评测通过', caps: [],
        probes: [{ id: 'identity', name: '模型身份探针', status: 'pass', score: 95, weight: 50, latencyMs: 210, summary: '指纹校验一致', evidence: 'sandbox-ok' }],
        capabilityChecks: [{ key: 'stream', label: 'SSE 流式', status: 'pass', detail: '首字 210ms', evidence: 'chunks=16' }],
        protocolChecks: [], usage: { requestCount: 3, inputTokens: 640, outputTokens: 280 },
        metrics: { modelRelation: 'exact', ttftMs: 210, tokensPerSecond: 78.2, throughputTokens: 280, generationMs: 3580, streamChunkCount: 24, avgLatencyMs: 240, latencyCv: 0.08 },
        durationMs: 1820,
      };
      state.evalReports = [report, ...(state.evalReports || [])];
      writeState(state);
      return { result: report };
    }
    if (cmd === 'delete_eval_report') {
      const state = readState();
      state.evalReports = (state.evalReports || []).filter((r) => r.id !== args.id);
      writeState(state);
      return { result: null };
    }

    if (cmd === 'load_model_map') return { result: readJson(cfgFile('model-map.json'), {}) };
    if (cmd === 'save_model_map') { writeJson(cfgFile('model-map.json'), args.map || {}); return { result: null }; }
    if (cmd === 'validate_model_map') return { result: { valid: true, issues: [], warnings: [] } };
    if (cmd === 'list_ide_models') return { result: readJson(cfgFile('ide-models.json'), { models: [], source: 'captured' }) };
    if (cmd === 'refresh_ide_models') {
      const ide = readJson(cfgFile('ide-models.json'), { models: [], account: {} });
      ide.captured_at = Date.now();
      writeJson(cfgFile('ide-models.json'), ide);
      return { result: { ...ide, ...(ide.account || {}) } };
    }
    if (cmd === 'list_windsurf_catalog') return { result: { models: (readJson(WINDSURF_CATALOG_PATH, { models: [] }).models || []).slice(0, 120) } };
    if (cmd === 'load_proxy_routes' || cmd === 'repair_proxy_routes') return { result: readJson(cfgFile('proxy-routes.json'), { version: 2, routes: [] }) };
    if (cmd === 'save_proxy_routes') { writeJson(cfgFile('proxy-routes.json'), args.store || {}); return { result: null }; }
    if (cmd === 'load_claude_desktop_bindings') return { result: readState().claudeDesktop?.bindings || [] };
    if (cmd === 'save_claude_desktop_bindings') {
      const state = readState();
      state.claudeDesktop = { ...(state.claudeDesktop || {}), bindings: args.bindings || [] };
      writeState(state);
      return { result: null };
    }

    if (cmd === 'get_agent_registry') {
      return {
        result: (readState().platforms || []).map((p) => ({
          id: p.id, name: p.displayName, vendor: p.vendor, api_format: p.requiredApiFormat, family: p.id,
          has_cli: Boolean(p.npm_package), npm_package: p.npm_package || null, official_url: 'https://example.invalid',
          installed: Boolean(p.installed), config_dir: path.dirname(p.configPath || sandboxDir), config_path: p.configPath,
          has_page: p.hasPage !== false, icon: p.id, current_model: p.currentProviderName || null,
        })),
      };
    }
    if (cmd === 'detect_platforms') return { result: readState().platforms || [] };
    if (cmd === 'list_provider_models') {
      return {
        result: (readProviders().providers || []).filter((p) => p.enabled !== false).map((p) => ({
          providerId: p.id, providerName: p.name, apiHost: p.apiHost, apiKey: p.apiKey, apiPath: p.apiPath,
          chatUrl: `${p.apiHost}${p.apiPath || ''}`, apiFormat: p.apiFormat,
          models: p.modelCatalog || (p.models || []).map((id) => ({ id, name: id, supportsToolCall: true, supportsImages: true, supportsReasoning: true })),
        })),
      };
    }
    if (cmd === 'preview_platform_switch') return { result: formatPlatformConfigText(args.platform) };
    if (cmd === 'switch_platform' || cmd === 'apply_declared_platform') {
      const store = readProviders();
      const prov = (store.providers || []).find((p) => p.id === args.providerId);
      const plat = updatePlatform(args.platform, { managedByAnyBridge: true, currentProviderId: args.providerId || null, currentProviderName: prov?.name || args.providerId || 'Sandbox Provider', appliedAt: new Date().toISOString() });
      store.platforms = { ...(store.platforms || {}), [args.platform]: { activeProviderId: args.providerId || null } };
      writeJson(cfgFile('providers.json'), store);
      return { result: { ok: true, message: '已在沙箱中接管配置', configPath: plat?.configPath || '', backupPath: `${plat?.configPath || ''}.bak` } };
    }
    if (cmd === 'restore_platform' || cmd === 'restore_declared_platform' || cmd.endsWith('_official_config')) {
      const pid = args.platform || (cmd.includes('claude') ? 'claude-code' : cmd.includes('codex') ? 'codex' : cmd.includes('grok') ? 'grok' : cmd.includes('opencode') ? 'opencode' : 'antigravity-ide');
      updatePlatform(pid, { managedByAnyBridge: false, currentProviderId: null, currentProviderName: null });
      return { result: { ok: true, message: '已还原沙箱默认配置' } };
    }
    if (cmd === 'read_agent_config_file' || cmd === 'read_platform_config_file') return { result: formatPlatformConfigText(args.platform) };
    if (cmd === 'write_platform_config_file') {
      const outPath = path.join(sandboxDir, 'mock-platforms', String(args.platform || 'custom'), 'config.txt');
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, String(args.content || ''), 'utf8');
      return { result: { ok: true } };
    }
    if (cmd === 'check_platform_update') {
      const plat = (readState().platforms || []).find((p) => p.id === args.platform);
      const installed = plat ? Boolean(plat.installed) : true;
      const ver = plat?.version || (installed ? '1.0.0' : null);
      return { result: { platform: args.platform, installed, current_version: ver, latest_version: ver, has_update: false, can_auto_update: false, has_self_update: false } };
    }
    if (['update_platform_agent', 'remove_opencode_config_from_live', 'repair_codex_session_visibility', 'restart_codex_desktop', 'start_codex_with_cdp'].includes(cmd)) {
      return { result: { ok: true, message: '沙箱指令已执行' } };
    }

    if (cmd.startsWith('load_') && cmd.endsWith('_models')) {
      const key = args.platform || managedPlatformKey(cmd);
      return { result: readState().managedModels?.[key] || { models: [], availableModels: [], _configPath: '', _configScope: 'user' } };
    }
    if (cmd.startsWith('save_') && cmd.endsWith('_models')) {
      const key = args.platform || managedPlatformKey(cmd);
      const state = readState();
      state.managedModels = state.managedModels || {};
      const prev = state.managedModels[key] || {};
      state.managedModels[key] = { ...prev, models: args.models || [], availableModels: args.availableModels || [], _configScope: args.scope || 'user' };
      writeState(state);
      return { result: prev._configPath || path.join(sandboxDir, 'mock-platforms', key, 'models.json') };
    }

    if (cmd.startsWith('cursor_')) return handleCursor(cmd, args);
    if (cmd.startsWith('extension_') || cmd.startsWith('plugin_')) return handleExtensionsAndPlugins(cmd, args);

    if (cmd === 'get_claude_desktop_status') return { result: readState().claudeDesktop || { supported: true, installed: true } };
    if (cmd === 'apply_claude_desktop' || cmd === 'restore_claude_desktop') {
      const state = readState();
      state.claudeDesktop.managedByAnyBridge = cmd === 'apply_claude_desktop';
      writeState(state);
      return { result: state.claudeDesktop };
    }
    if (cmd === 'preview_claude_desktop') return { result: formatPlatformConfigText('claude-desktop') };

    if (cmd === 'get_proxy_status') {
      const state = readState();
      const cfg = readCfg().values || {};
      return { result: { running: Boolean(state.proxy?.running) || sidecarHandle.isRunning(), target_ide: cfg.target_ide || state.proxy?.target_ide || 'windsurf', api_port: Number(cfg.PROXY_PORT || ports.apiPort), inference_port: Number(cfg.INFERENCE_PORT || ports.inferencePort) } };
    }
    if (['start_proxy_service', 'stop_proxy_service', 'restart_proxy_service', 'start_proxy', 'stop_proxy'].includes(cmd)) {
      const state = readState();
      state.proxy = { ...(state.proxy || {}), running: !cmd.startsWith('stop') };
      writeState(state);
      return { result: { running: state.proxy.running, api_port: ports.apiPort, inference_port: ports.inferencePort } };
    }
    if (cmd === 'get_ide_proxy_status') return { result: { target: args.target || readCfg().values?.target_ide || 'windsurf', patched: true, running: true, proxyUrl: `http://127.0.0.1:${ports.apiPort}` } };
    if (['switch_ide_to_proxy', 'restore_ide_direct', 'patch_ide_config', 'restore_ide_config', 'patch_ide_settings', 'restore_ide_settings'].includes(cmd)) {
      return { result: { ok: true, message: '沙箱 IDE 代理配置已更新' } };
    }
    if (cmd === 'get_takeover_state') return { result: readJson(cfgFile('anybridge-takeover-state.json'), {}) };
    if (cmd === 'get_stats') return { result: readState().stats || {} };
    if (cmd === 'get_stats_history') {
      const days = readState().dailyHistory || [];
      const limit = Number(args.days) > 0 ? Number(args.days) : days.length;
      return { result: { days: days.slice(-limit) } };
    }
    if (cmd === 'get_stats_settings') return { result: readState().statsSettings || { disabledSources: [], availableSources: [] } };
    if (cmd === 'set_stats_settings') {
      const state = readState();
      state.statsSettings = { availableSources: ['gateway', 'claude-code', 'cursor', 'cpa', 'pi', 'zcode'], ...(state.statsSettings || {}), disabledSources: Array.isArray(args.disabledSources) ? args.disabledSources : [] };
      writeState(state);
      return { result: state.statsSettings };
    }
    if (cmd === 'get_local_usage' || cmd === 'scan_local_usage') return { result: readJson(cfgFile('usage-local.json'), { version: 2, days: {} }) };
    if (cmd === 'preflight_proxy') return { result: { ok: true, checks: [{ id: 'port', status: 'ok', message: `沙箱端口 ${ports.apiPort} 就绪` }] } };
    if (cmd === 'healthcheck_grouped') {
      return {
        result: {
          targetIde: args.targetIde || 'windsurf', ok: true, generatedAt: new Date().toISOString(), totals: { ok: 5, warn: 0, err: 0 },
          groups: [
            { id: 'proxy', title: '本地网关服务', icon: 'server', issues: [], errors: 0, warnings: 0, oks: 2 },
            { id: 'certs', title: '本地 HTTPS 证书', icon: 'shield', issues: [], errors: 0, warnings: 0, oks: 2 },
            { id: 'ide', title: '目标客户端配置', icon: 'cpu', issues: [], errors: 0, warnings: 0, oks: 1 },
          ],
        },
      };
    }

    if (cmd === 'get_app_version') return { result: appVer() };
    if (cmd === 'should_check_updates') return { result: false };
    if (cmd === 'get_update_settings') return { result: readJson(cfgFile('update_settings.json'), { autoCheck: false, channel: 'stable' }) };
    if (cmd === 'save_update_settings' || cmd === 'patch_update_settings') {
      const prev = readJson(cfgFile('update_settings.json'), {});
      const next = cmd === 'save_update_settings' ? (args.settings || prev) : { ...prev, ...(args || {}) };
      writeJson(cfgFile('update_settings.json'), next);
      return { result: next };
    }
    if (cmd === 'get_autostart') return { result: Boolean(readState().autostart) };
    if (cmd === 'set_autostart') { const s = readState(); s.autostart = Boolean(args.enabled); writeState(s); return { result: s.autostart }; }
    if (cmd === 'detect_ide_path' || cmd === 'detect_windsurf_path') return { result: path.join(sandboxDir, 'mock-ide', String(args.target || 'windsurf')) };
    if (cmd === 'detect_target_ide') return { result: readCfg().values?.target_ide || 'windsurf' };
    if (cmd === 'is_ide_running') return { result: false };
    if (cmd === 'cert_check_status') return { result: { ...(readState().certs || {}), installed: true, trusted: true, legacyCount: 0 } };
    if (cmd.startsWith('cert_') || cmd === 'generate_certs') return { result: '沙箱证书状态已更新' };
    if (['get_antigravity_localization_status', 'get_app_localization_status', 'get_antigravity_cdp_status'].includes(cmd)) {
      const loc = readState().localization || {};
      return { result: { localized: Boolean(loc.appApplied), langPackInstalled: true, currentVersion: loc.latestVersion || '1.104.0', cdpApplied: Boolean(loc.cdpApplied) } };
    }
    if (cmd.includes('localization')) return { result: { ok: true, message: '沙箱语言包操作完成', currentVersion: '1.104.0' } };
    if (cmd === 'sandbox_write_export') {
      const out = path.join(sandboxDir, 'exports', path.basename(String(args.path || 'export.txt')));
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, String(args.content || ''), 'utf8');
      return { result: out };
    }
    if (NOOP_NULL_CMDS.has(cmd)) return { result: null };

    console.warn(`[dev-sandbox] unhandled invoke command fallback: ${cmd}`);
    return { result: null };
  };
}

async function waitSidecarHealth(apiPort, proxyKey, isRunning) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline && isRunning()) {
    try {
      const r = await fetch(`http://127.0.0.1:${apiPort}/health`, {
        headers: proxyKey ? { authorization: `Bearer ${proxyKey}` } : {},
        signal: AbortSignal.timeout(800),
      });
      if (r.ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 120));
  }
  return false;
}

function startSidecar(configDir, ports) {
  const entry = path.join(REPO_ROOT, 'sidecar', 'proxy-entry.js');
  if (!fs.existsSync(entry)) return { isRunning: () => false, stop: () => {} };
  const child = spawn(process.execPath, [entry], {
    cwd: REPO_ROOT, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env, BYOK_CONFIG_DIR: configDir,
      API_PORT: String(ports.apiPort), INFERENCE_PORT: String(ports.inferencePort), ANTIGRAVITY_HTTPS_PORT: String(ports.agHttpsPort),
    },
  });
  let running = true;
  child.stdout?.on('data', (chunk) => process.stdout.write(`[sidecar] ${chunk}`));
  child.stderr?.on('data', (chunk) => process.stderr.write(`[sidecar] ${chunk}`));
  child.on('exit', () => { running = false; });
  return {
    isRunning: () => running,
    stop: () => { if (running && !child.killed) { try { child.kill('SIGTERM'); } catch {} } },
  };
}

export async function startSandboxServer(options = {}) {
  const { port = 17480, sandboxDir = DEFAULT_SANDBOX_DIR, reseed = false, sidecar = true, apiPort, inferencePort, agHttpsPort } = options;
  const ports = {
    apiPort: await resolvePortOption(apiPort, 17450),
    inferencePort: await resolvePortOption(inferencePort, 17451),
    agHttpsPort: await resolvePortOption(agHttpsPort, 17452),
  };
  const seedRes = seedSandbox({ sandboxDir, reseed, ports });
  const cfgPath = path.join(seedRes.configDir, 'byok-config.json');
  const cfg = readJson(cfgPath, { values: {} });
  cfg.values = { ...(cfg.values || {}), PROXY_PORT: String(ports.apiPort), API_PORT: String(ports.apiPort), INFERENCE_PORT: String(ports.inferencePort), ANTIGRAVITY_HTTPS_PORT: String(ports.agHttpsPort) };
  writeJson(cfgPath, cfg);

  const sidecarHandle = sidecar ? startSidecar(seedRes.configDir, ports) : { isRunning: () => false, stop: () => {} };
  if (sidecar) await waitSidecarHealth(ports.apiPort, cfg.values.LOCAL_PROXY_KEY, sidecarHandle.isRunning);
  const routeInvoke = createInvokeRouter({ sandboxDir: seedRes.sandboxDir, configDir: seedRes.configDir, sidecarHandle, ports });

  const server = http.createServer(async (req, res) => {
    const reqUrl = new URL(req.url || '/', 'http://127.0.0.1');
    const pathname = decodeURIComponent(reqUrl.pathname);

    if (req.method === 'POST' && pathname === '/__sandbox/invoke') {
      const chunks = [];
      for await (const ch of req) chunks.push(ch);
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        const payload = await routeInvoke(body.cmd, body.args || {});
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ ok: true, result: payload?.result ?? null, events: payload?.events || [] }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: String(err?.message || err) }));
      }
      return;
    }

    if (req.method === 'GET' && pathname === '/__sandbox_bridge.js') {
      res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(fs.readFileSync(BRIDGE_SCRIPT_PATH, 'utf8'));
      return;
    }

    const relPath = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    const targetPath = path.resolve(UI_ROOT, relPath);
    if (!targetPath.startsWith(UI_ROOT) || !fs.existsSync(targetPath) || fs.statSync(targetPath).isDirectory()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
      return;
    }

    if (relPath === 'index.html') {
      const injected = fs.readFileSync(targetPath, 'utf8').replace(/<head[^>]*>/i, (m) => `${m}\n  <script src="/__sandbox_bridge.js"></script>`);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(injected);
      return;
    }

    res.writeHead(200, { 'Content-Type': MIME_MAP[path.extname(targetPath).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    fs.createReadStream(targetPath).pipe(res);
  });

  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  const addr = server.address();
  const actualPort = typeof addr === 'object' && addr ? addr.port : port;
  return {
    url: `http://127.0.0.1:${actualPort}`, port: actualPort, ports, sandboxDir: seedRes.sandboxDir, configDir: seedRes.configDir,
    close: async () => { sidecarHandle.stop(); await new Promise((resolve) => server.close(() => resolve())); },
  };
}

const isCli = process.argv[1] && path.resolve(process.argv[1]) === __filename;
if (isCli) {
  const opts = parseCliArgs(process.argv.slice(2));
  const inst = await startSandboxServer(opts);
  console.log(`[dev-sandbox] listening on ${inst.url} (sandbox=${inst.configDir}, sidecar=${opts.sidecar}, apiPort=${inst.ports.apiPort}, inferencePort=${inst.ports.inferencePort}, agHttpsPort=${inst.ports.agHttpsPort})`);
  const shutdown = async () => { await inst.close(); process.exit(0); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
