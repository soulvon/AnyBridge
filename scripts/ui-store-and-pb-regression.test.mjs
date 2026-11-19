import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const ROOT = process.cwd();

function readUi(relPath) {
  return fs.readFileSync(path.join(ROOT, relPath), 'utf8');
}

function stripEsmSyntax(code) {
  return code
    .replace(/^\s*import\s+[\s\S]*?from\s+['"][^'"]+['"];\s*$/gm, '')
    .replace(/^\s*import\s+['"][^'"]+['"];\s*$/gm, '')
    .replace(/\bexport\s+(async\s+function|function|const|let|class)\b/g, '$1')
    .replace(/\bexport\s+\{[^}]*\};?/g, '');
}

function createFakeEl(id = '', initial = {}) {
  const classes = new Set();
  const children = {};
  const el = {
    id,
    value: '',
    checked: false,
    disabled: false,
    hidden: false,
    textContent: '',
    innerHTML: '',
    style: {},
    dataset: {},
    attributes: {},
    classList: {
      add: (...cs) => cs.forEach(c => classes.add(c)),
      remove: (...cs) => cs.forEach(c => classes.delete(c)),
      toggle: (c, force) => (force === undefined ? (classes.has(c) ? (classes.delete(c), false) : (classes.add(c), true)) : (force ? (classes.add(c), true) : (classes.delete(c), false))),
      contains: c => classes.has(c),
    },
    setAttribute: (k, v) => { el.attributes[k] = String(v); },
    getAttribute: k => el.attributes[k],
    querySelector: sel => children[sel] || null,
    querySelectorAll: () => [],
    closest: () => null,
    focus: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    _children: children,
    ...initial,
  };
  return el;
}

function createBaseSandbox(extra = {}) {
  const elements = new Map();
  const docListeners = {};
  const document = {
    hidden: false,
    readyState: 'complete',
    getElementById: id => elements.get(id) || null,
    querySelectorAll: () => [],
    querySelector: () => null,
    createElement: () => createFakeEl(),
    addEventListener: (ev, fn) => {
      docListeners[ev] = docListeners[ev] || [];
      docListeners[ev].push(fn);
    },
    removeEventListener: () => {},
    body: createFakeEl('body'),
  };

  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    URL,
    Blob: class FakeBlob {},
    localStorage: {
      _map: new Map(),
      getItem: k => sandbox.localStorage._map.get(k) ?? null,
      setItem: (k, v) => sandbox.localStorage._map.set(k, String(v)),
    },
    document,
    navigator: { clipboard: { writeText: async () => {} } },
    addLog: () => {},
    showCustomAlert: () => {},
    showBottomToast: () => {},
    showCustomConfirm: async () => true,
    renderProviders: () => {},
    renderEvalProviderOptions: () => {},
    renderModelMap: async () => {},
    renderPlatformProviderOptions: () => {},
    renderPlatformDetailStatuses: () => {},
    navigateTo: () => {},
    platformEsc: s => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;'),
    platformJoinUrl: (h, p) => {
      const host = String(h || '').trim().replace(/\/+$/, '');
      const ap = String(p || '').trim();
      return !host ? '' : !ap || ap === '/' ? host : `${host}${ap.startsWith('/') ? ap : '/' + ap}`;
    },
    platformStripSuffix: (url, suffixes) => {
      let out = String(url || '').trim().replace(/\/+$/, '');
      for (const s of suffixes) {
        if (out.toLowerCase().endsWith(s.toLowerCase())) {
          out = out.slice(0, out.length - s.length).replace(/\/+$/, '');
          break;
        }
      }
      return out;
    },
    platformSetText: (id, text) => {
      const el = document.getElementById(id);
      if (el) el.textContent = text;
    },
    ...extra,
  };
  sandbox.globalThis = sandbox;
  sandbox.window = sandbox;
  sandbox._elements = elements;
  sandbox._docListeners = docListeners;
  return sandbox;
}

function loadScriptsIntoSandbox(sandbox, relPaths) {
  vm.createContext(sandbox);
  for (const rel of relPaths) {
    const raw = readUi(rel);
    vm.runInContext(stripEsmSyntax(raw), sandbox, { filename: rel });
  }
  return sandbox;
}

test('provider-store: resolveBoundProviderView tracks live primary provider fields & overrides', () => {
  const sb = loadScriptsIntoSandbox(createBaseSandbox(), ['ui/assets/scripts/state/provider-store.js']);
  const store = {
    providers: [
      {
        id: 'p-main',
        name: 'Updated Relay',
        apiHost: 'https://new.relay.example',
        apiPath: '/v1/messages',
        apiKey: 'sk-live-new',
        apiFormat: 'anthropic',
        enabled: true,
      },
      {
        id: 'p-off',
        name: 'Disabled Relay',
        apiHost: 'https://off.example',
        apiPath: '/v1',
        apiKey: 'sk-off',
        apiFormat: 'openai',
        enabled: false,
      },
    ],
  };

  const view = sb.resolveBoundProviderView({
    id: 'cfg-1',
    sourceProviderId: 'p-main',
    apiHost: 'https://stale.example',
    apiPath: '/old',
    apiKey: 'sk-stale',
    apiFormat: 'openai',
    enabled: true,
  }, store);

  assert.equal(view.hasSource, true);
  assert.equal(view.sourceMissing, false);
  assert.equal(view.apiHost, 'https://new.relay.example');
  assert.equal(view.apiPath, '/v1/messages');
  assert.equal(view.apiKey, 'sk-live-new');
  assert.equal(view.apiFormat, 'anthropic');
  assert.equal(view.enabled, true);

  const overrideView = sb.resolveBoundProviderView({
    id: 'cfg-2',
    sourceProviderId: 'p-main',
    apiFormatOverride: 'openai',
  }, store);
  assert.equal(overrideView.apiFormat, 'openai');

  const disabledView = sb.resolveBoundProviderView({
    id: 'cfg-3',
    sourceProviderId: 'p-off',
    enabled: true,
  }, store);
  assert.equal(disabledView.enabled, false);

  const missingView = sb.resolveBoundProviderView({
    id: 'cfg-4',
    sourceProviderId: 'p-deleted',
    apiHost: 'https://fallback.example',
    apiKey: 'sk-fallback',
  }, store);
  assert.equal(missingView.hasSource, false);
  assert.equal(missingView.sourceMissing, true);
  assert.equal(missingView.apiHost, 'https://fallback.example');
});

test('provider-store: serializes mutations, filters virtual builtins, and rolls back 100% on failure', async () => {
  const savedPayloads = [];
  const callOrder = [];
  let failNextSave = false;
  const toasts = [];

  const sb = loadScriptsIntoSandbox(createBaseSandbox({
    showBottomToast: (msg, type) => toasts.push({ msg, type }),
    invoke: async (cmd, payload) => {
      if (cmd === 'save_providers') {
        callOrder.push(`start:${payload.store.providers.map(p => p.id).join(',')}`);
        await new Promise(r => setTimeout(r, 15));
        if (failNextSave) {
          callOrder.push('fail');
          throw new Error('disk full');
        }
        savedPayloads.push(JSON.parse(JSON.stringify(payload.store)));
        callOrder.push('ok');
      }
    },
  }), ['ui/assets/scripts/state/provider-store.js']);

  // Guard: refuse save when not loaded yet
  sb.providerStoreLoaded = false;
  const blocked = await sb.mutateProviderStore(s => { s.providers.push({ id: 'p-early' }); });
  assert.equal(blocked, false);
  assert.equal(sb.providerStore.providers.length, 0);

  sb.providerStore = {
    version: 1,
    providers: [
      { id: 'anybridge-local-proxy', name: 'AnyBridge', isLocalProxy: true },
      { id: 'p-1', name: 'One', apiHost: 'https://one.example', apiKey: 'sk-1' },
    ],
    antigravityConfigs: [{ id: 'ag-1', sourceProviderId: 'p-1' }],
  };
  sb.providerStoreLoaded = true;
  sb.markProviderStoreSnapshot(sb.providerStore);

  // Concurrent serial queue & virtual builtin filtering
  const pA = sb.mutateProviderStore(s => {
    s.providers.push({ id: 'p-2', name: 'Two', apiHost: 'https://two.example', apiKey: 'sk-2' });
  });
  const pB = sb.mutateProviderStore(s => {
    s.providers.push({ id: 'p-3', name: 'Three', apiHost: 'https://three.example', apiKey: 'sk-3' });
  });
  const [okA, okB] = await Promise.all([pA, pB]);
  assert.equal(okA, true);
  assert.equal(okB, true);
  assert.deepEqual(callOrder, ['start:p-1,p-2', 'ok', 'start:p-1,p-2,p-3', 'ok']);
  assert.equal(savedPayloads.length, 2);
  assert.equal(savedPayloads[1].providers.some(p => p.id === 'anybridge-local-proxy'), false);
  assert.equal(sb.providerStore.providers.some(p => p.id === 'anybridge-local-proxy'), true);

  // Rollback on failure + onRollback invocation
  failNextSave = true;
  let rolledBackErr = null;
  const okFail = await sb.mutateProviderStore(s => {
    s.providers.push({ id: 'p-bad', name: 'Bad' });
    s.antigravityConfigs.push({ id: 'ag-bad' });
  }, {
    onRollback: err => { rolledBackErr = err; },
  });

  assert.equal(okFail, false);
  assert.ok(rolledBackErr instanceof Error);
  assert.equal(sb.providerStore.providers.some(p => p.id === 'p-bad'), false);
  assert.equal(sb.providerStore.antigravityConfigs.some(c => c.id === 'ag-bad'), false);
  assert.equal(sb.providerStore.providers.length, 4);
  assert.ok(toasts.some(t => t.type === 'error'));
});

test('B-P0-3: selectAntigravityMode and antigravityDrop use transaction persistence without write_provider_store', async () => {
  const agConsoleSrc = readUi('ui/assets/scripts/platforms/antigravity_console.js');
  const factorySrc = readUi('ui/assets/scripts/platforms/models_table_factory.js');
  assert.equal(/write_provider_store/.test(factorySrc), false);
  assert.equal(/save_providers/.test(agConsoleSrc), false);

  const btnPure = createFakeEl('', { dataset: { mode: 'pure' } });
  const btnHybrid = createFakeEl('', { dataset: { mode: 'hybrid' } });
  let shouldFail = true;
  const sb = createBaseSandbox({
    invoke: async (cmd, payload) => {
      if (cmd === 'save_providers') {
        if (shouldFail) throw new Error('disk locked');
        return payload;
      }
    },
  });
  sb.document.querySelectorAll = sel => (sel === '.antigravity-mode-seg-btn' ? [btnPure, btnHybrid] : []);
  loadScriptsIntoSandbox(sb, [
    'ui/assets/scripts/state/provider-store.js',
    'ui/assets/scripts/platforms/antigravity_console.js',
  ]);
  sb.providerStore = {
    version: 1,
    antigravityMode: 'pure',
    providers: [{ id: 'anybridge-local-proxy', isLocalProxy: true }],
  };
  sb.providerStoreLoaded = true;
  sb.markProviderStoreSnapshot(sb.providerStore);

  await sb.selectAntigravityMode('hybrid');
  assert.equal(sb.providerStore.antigravityMode, 'pure');
  assert.equal(btnPure.classList.contains('is-active'), true);
  assert.equal(btnHybrid.classList.contains('is-active'), false);

  // Drop test: simulate FileReader & failure rollback
  const alerts = [];
  let renderCount = 0;
  let dropShouldFail = true;
  const dropSb = createBaseSandbox({
    showCustomAlert: (msg, title, type) => alerts.push({ msg, title, type }),
    antigravityRenderTableRows: () => { renderCount += 1; },
    antigravityRefreshConsole: () => {},
    FileReader: class MockFileReader {
      readAsText() {
        setTimeout(() => this.onload?.({ target: { result: JSON.stringify([{ id: 'ag-new', name: 'New', sourceProviderId: 'p-1' }]) } }), 0);
      }
    },
    invoke: async cmd => {
      if (cmd === 'save_providers' && dropShouldFail) throw new Error('write error');
    },
    openPlatformPage: () => {},
    cbModels: [], cbAvailableModels: [], wbModels: [], wbAvailableModels: [], zcModels: [], zcAvailableModels: [],
    renderCodeBuddyModels: () => {}, saveCodeBuddyModels: async () => {}, loadCodeBuddyModels: async () => {},
    renderWbModels: () => {}, saveWbModels: async () => {}, loadWbModels: async () => {},
    renderZcModels: () => {}, saveZcModels: async () => {}, loadZcModels: async () => {},
  });
  loadScriptsIntoSandbox(dropSb, [
    'ui/assets/scripts/state/provider-store.js',
    'ui/assets/scripts/platforms/models_table_factory.js',
  ]);
  dropSb.providerStore = { version: 1, providers: [], antigravityConfigs: [] };
  dropSb.providerStoreLoaded = true;
  dropSb.markProviderStoreSnapshot(dropSb.providerStore);

  dropSb.antigravityDrop({
    preventDefault: () => {},
    stopPropagation: () => {},
    dataTransfer: { files: [{ name: 'models.json' }] },
  });
  await new Promise(r => setTimeout(r, 40));
  assert.equal(dropSb.providerStore.antigravityConfigs.length, 0);
  assert.ok(alerts.some(a => a.type === 'error'));
  assert.equal(alerts.some(a => a.title === '导入成功'), false);
  assert.ok(renderCount >= 1);
});

test('stale settingsConfig.env/options cannot overwrite bound main provider on save', async () => {
  const sb = createBaseSandbox({
    invoke: async () => {},
    platformInfoOf: () => ({}),
    platformProviderList: () => [],
    resetPasswordInputVisibility: () => {},
    codexInferWireApi: () => 'responses',
    codexTargetBaseUrl: p => sb.platformJoinUrl(p?.apiHost, p?.apiPath),
    codexConfigModelList: p => p?.models || ['claude-sonnet-4-5'],
    codexConfigParseModels: (v, d) => [d].filter(Boolean),
    codexConfigNormalizeModels: l => (Array.isArray(l) ? l : [l]).filter(Boolean),
    sanitizePlatformModelName: s => String(s || '').trim(),
    ensureOneMContextMarker: m => m,
    stripOneMContextMarker: m => m,
    isAnyRouterEndpoint: () => false,
    grok_sanitize_key: s => s,
    claudeCodeExtractModelsFromRoleForm: () => ['claude-sonnet-4-5'],
    claudeCodeConfigObjectFromRawOrFields: () => JSON.parse(sb.document.getElementById('claude-code-config-raw-json').value),
    claudeCodeConfigEndpointParts: url => ({ apiHost: url.replace(/\/v1.*$/, ''), apiPath: '/v1/messages' }),
  });
  const setVal = (id, val) => {
    const el = createFakeEl(id, { value: val });
    sb._elements.set(id, el);
    return el;
  };
  loadScriptsIntoSandbox(sb, [
    'ui/assets/scripts/state/provider-store.js',
    'ui/assets/scripts/platforms/shared_config_editor.js',
    'ui/assets/scripts/platforms/claude_code_settings.js',
    'ui/assets/scripts/platforms/claude_code_editor.js',
    'ui/assets/scripts/platforms/opencode_config.js',
    'ui/assets/scripts/platforms/opencode_editor.js',
  ]);

  sb.providerStore = {
    version: 1,
    providers: [
      {
        id: 'p-main',
        name: 'Main Relay',
        apiHost: 'https://fresh-main.example',
        apiPath: '/v1/messages',
        apiKey: 'sk-fresh-main',
        apiFormat: 'anthropic',
        enabled: true,
        models: ['claude-sonnet-4-5'],
      },
      {
        id: 'p-openai',
        name: 'Main OpenAI Relay',
        apiHost: 'https://fresh-openai.example',
        apiPath: '/v1/chat/completions',
        apiKey: 'sk-fresh-openai',
        apiFormat: 'openai',
        enabled: true,
        models: ['gpt-4.1'],
      },
    ],
    claudeCodeConfigs: [{
      id: 'cc-1',
      name: 'CC Profile',
      sourceProviderId: 'p-main',
      apiHost: 'https://stale-cc.example',
      apiPath: '/v1/messages',
      apiKey: 'sk-stale-cc',
      defaultModel: 'claude-sonnet-4-5',
      models: ['claude-sonnet-4-5'],
      settingsConfig: {
        env: {
          ANTHROPIC_BASE_URL: 'https://stale-cc.example',
          ANTHROPIC_AUTH_TOKEN: 'sk-stale-cc',
          ANTHROPIC_API_KEY: 'sk-stale-api-key',
          ANTHROPIC_MODEL: 'claude-sonnet-4-5',
        },
      },
    }],
    opencodeConfigs: [{
      id: 'oc-1',
      name: 'OC Profile',
      sourceProviderId: 'p-openai',
      apiHost: 'https://stale-oc.example',
      apiPath: '/v1',
      apiKey: 'sk-stale-oc',
      defaultModel: 'gpt-4.1',
      models: ['gpt-4.1'],
      settingsConfig: {
        name: 'OC Profile',
        options: {
          baseURL: 'https://stale-oc.example/v1',
          apiKey: 'sk-stale-oc',
        },
        models: { 'gpt-4.1': { name: 'gpt-4.1' } },
      },
    }],
  };
  sb.providerStoreLoaded = true;
  sb.markProviderStoreSnapshot(sb.providerStore);

  // Claude Code save with stale raw JSON & stale DOM values
  setVal('claude-code-config-edit-id', 'cc-1');
  setVal('claude-code-config-source-id', 'p-main');
  setVal('claude-code-config-name', 'CC Profile');
  setVal('claude-code-config-base-url', 'https://stale-dom.example');
  setVal('claude-code-config-api-key', 'sk-stale-dom');
  setVal('claude-code-config-model', 'claude-sonnet-4-5');
  setVal('claude-code-config-raw-json', JSON.stringify(sb.providerStore.claudeCodeConfigs[0].settingsConfig));

  await sb.saveClaudeCodeConfigEditor(false);
  const savedCc = sb.providerStore.claudeCodeConfigs[0];
  assert.equal(savedCc.apiHost, 'https://fresh-main.example');
  assert.equal(savedCc.apiKey, 'sk-fresh-main');
  assert.equal(savedCc.settingsConfig.env.ANTHROPIC_BASE_URL, 'https://fresh-main.example');
  assert.equal(savedCc.settingsConfig.env.ANTHROPIC_AUTH_TOKEN, 'sk-fresh-main');
  assert.equal(savedCc.settingsConfig.env.ANTHROPIC_API_KEY, 'sk-fresh-main');

  // OpenCode save with stale raw JSON options & stale DOM values
  setVal('opencode-config-edit-id', 'oc-1');
  setVal('opencode-config-source-id', 'p-openai');
  setVal('opencode-config-name', 'OC Profile');
  setVal('opencode-config-base-url', 'https://stale-oc-dom.example/v1');
  setVal('opencode-config-api-key', 'sk-stale-oc-dom');
  setVal('opencode-config-model', 'gpt-4.1');
  setVal('opencode-config-models', 'gpt-4.1');
  setVal('opencode-config-raw-json', JSON.stringify(sb.providerStore.opencodeConfigs[0].settingsConfig));

  await sb.saveOpenCodeConfigEditor(false);
  const savedOc = sb.providerStore.opencodeConfigs[0];
  assert.equal(savedOc.apiHost, 'https://fresh-openai.example');
  assert.equal(savedOc.apiKey, 'sk-fresh-openai');
  assert.equal(savedOc.settingsConfig.options.baseURL, 'https://fresh-openai.example/v1');
  assert.equal(savedOc.settingsConfig.options.apiKey, 'sk-fresh-openai');

  // Verify endpoint-and-editor saveProviderFromEditor pushes updates into settingsConfig.env & options
  loadScriptsIntoSandbox(sb, ['ui/assets/scripts/model-picker/endpoint-and-editor.js']);
  sb.selectedModels = ['claude-sonnet-4-5'];
  sb.editorDraftModelCaps = {};
  setVal('pf-id', 'p-main');
  setVal('pf-name', 'Main Relay');
  setVal('pf-format', 'anthropic');
  setVal('pf-host', 'https://pushed-v2.example');
  setVal('pf-path', '/v1/messages');
  setVal('pf-key', 'sk-pushed-v2');
  sb.providerStore.opencodeConfigs[0].sourceProviderId = 'p-main';
  await sb.saveProviderFromEditor();
  assert.equal(sb.providerStore.claudeCodeConfigs[0].settingsConfig.env.ANTHROPIC_BASE_URL, 'https://pushed-v2.example');
  assert.equal(sb.providerStore.claudeCodeConfigs[0].settingsConfig.env.ANTHROPIC_AUTH_TOKEN, 'sk-pushed-v2');
  assert.equal(sb.providerStore.claudeCodeConfigs[0].settingsConfig.env.ANTHROPIC_API_KEY, 'sk-pushed-v2');
  assert.equal(sb.providerStore.opencodeConfigs[0].settingsConfig.options.apiKey, 'sk-pushed-v2');
});

test('B-P0-4: 57-pb-models.js removed; Pi/Hermes/Dsh unified 7-col rows, counts, search, and static reachability', async () => {
  assert.equal(fs.existsSync(path.join(ROOT, 'ui/assets/scripts/57-pb-models.js')), false);
  assert.equal(readUi('ui/assets/scripts/main.js').includes('57-pb-models.js'), false);

  const sb = createBaseSandbox({
    MANAGED_MODEL_PLATFORM_IDS: { Pi: 'pi', Hermes: 'hermes', Dsh: 'deepseek-harness' },
    cbSelectedModelIds: {},
    cbApplyConfigMeta: (domPrefix, data) => ({ scope: data?.scope || 'user' }),
    showCustomAlert: (msg, title, type) => {
      if (type === 'error') throw new Error(`unexpected alert ${title}: ${msg}`);
    },
    invoke: async cmd => {
      if (cmd === 'load_pi_models' || cmd === 'load_hermes_models' || cmd === 'load_deepseek_harness_models') {
        return {
          models: [
            { id: 'gpt-4.1', name: 'Relay', vendor: 'Relay', supportsToolCall: true, maxInputTokens: 128000, enabled: true },
            { id: 'claude-3-7', name: 'Other', vendor: 'Other', supportsImages: true, maxInputTokens: 200000, enabled: false },
          ],
          availableModels: ['gpt-4.1', 'claude-3-7'],
          configPath: '~/cfg.json',
          scope: 'user',
        };
      }
      return {};
    },
    recommendContextWindow: () => 256000,
    recommendMaxOutputTokens: () => 16384,
    platformDef: id => ({ id, name: id }),
    isBuiltinProxyEntry: () => false,
    openPlatformPage: () => {},
    cbModels: [], cbAvailableModels: [], wbModels: [], wbAvailableModels: [], zcModels: [], zcAvailableModels: [],
    renderCodeBuddyModels: () => {}, saveCodeBuddyModels: async () => {}, loadCodeBuddyModels: async () => {},
    renderWbModels: () => {}, saveWbModels: async () => {}, loadWbModels: async () => {},
    renderZcModels: () => {}, saveZcModels: async () => {}, loadZcModels: async () => {},
    renderCbAddProviderList: () => {}, renderWbAddProviderList: () => {}, renderZcAddProviderList: () => {},
    renderGrokAddProviderList: () => {}, renderOpenCodeAddProviderList: () => {},
    renderCodexAddProviderList: () => {}, renderClaudeAddProviderList: () => {},
    renderCursorAddProviderList: () => {}, renderAntigravityAddProviderList: () => {},
  });

  for (const p of ['pi', 'hermes', 'dsh']) {
    sb._elements.set(`${p}-model-tbody`, createFakeEl(`${p}-model-tbody`));
    sb._elements.set(`${p}-model-empty`, createFakeEl(`${p}-model-empty`));
    sb._elements.set(`${p}-model-table`, createFakeEl(`${p}-model-table`));
    sb._elements.set(`${p}-model-count`, createFakeEl(`${p}-model-count`));
    sb._elements.set(`${p}-model-search`, createFakeEl(`${p}-model-search`));
    sb._elements.set(`${p}-add-provider-list`, createFakeEl(`${p}-add-provider-list`));
  }

  loadScriptsIntoSandbox(sb, [
    'ui/assets/scripts/platforms/core_helpers.js',
    'ui/assets/scripts/platforms/buddy_model_helpers.js',
    'ui/assets/scripts/platforms/models_table_factory.js',
    'ui/assets/scripts/platforms/model_list_rows.js',
    'ui/assets/scripts/platforms/platform_add_sort.js',
    'ui/assets/scripts/platforms/managed_models.js',
  ]);

  await sb.loadPiModels();
  await sb.loadHermesModels();
  await sb.loadDshModels();

  for (const p of ['pi', 'hermes', 'dsh']) {
    assert.equal(sb._elements.get(`${p}-model-count`).textContent, '共 2 个');
    const tbodyHtml = sb._elements.get(`${p}-model-tbody`).innerHTML;
    assert.equal(tbodyHtml.includes('wb-context-cell'), true, `${p} must use wb-context-cell CSS`);
    assert.equal((tbodyHtml.match(/<tr /g) || []).length, 2);
    const firstRowCells = tbodyHtml.split('</tr>')[0].match(/<td\b/g) || [];
    assert.equal(firstRowCells.length, 7, `${p} row must have 7 columns`);
  }

  // Search filter works for Hermes / Dsh
  sb._elements.get('hermes-model-search').value = 'claude';
  sb.onHermesModelSearch();
  const filteredHtml = sb._elements.get('hermes-model-tbody').innerHTML;
  assert.equal((filteredHtml.match(/<tr /g) || []).length, 1);
  assert.equal(filteredHtml.includes('claude-3-7'), true);

  // platform_add_sort renders Pi / Hermes / Dsh add lists
  sb.piProviderModels = [
    { providerId: 'p-z', providerName: 'Zeta', models: [{ id: 'm1' }] },
    { providerId: 'p-a', providerName: 'Alpha', models: [{ id: 'm2' }] },
  ];
  sb.hermesProviderModels = [...sb.piProviderModels];
  sb.dshProviderModels = [...sb.piProviderModels];
  sb.setPlatformAddProviderSortMode('name-asc');
  for (const p of ['pi', 'hermes', 'dsh']) {
    const html = sb._elements.get(`${p}-add-provider-list`).innerHTML;
    assert.ok(html.indexOf('Alpha') >= 0 && html.indexOf('Alpha') < html.indexOf('Zeta'), `${p} add provider list sorted`);
  }

  // All 30 previously missing dynamic actions are reachable on globalThis
  const actionsToCheck = [
    'applyCbJson', 'applyDshJson', 'applyHermesJson', 'applyPiJson', 'applyWbJson',
    'chooseDshAddSortMode', 'chooseHermesAddSortMode',
    'exportCbModels', 'exportDshModels', 'exportHermesModels', 'exportPiModels', 'exportWbModels',
    'formatCbJson', 'formatDshJson', 'formatHermesJson', 'formatPiJson', 'formatWbJson', 'formatZcJson',
    'importCbModels', 'importDshModels', 'importHermesModels', 'importPiModels', 'importWbModels',
    'toggleCbJsonEditor', 'toggleDshAddSort', 'toggleDshJsonEditor',
    'toggleHermesAddSort', 'toggleHermesJsonEditor', 'togglePiJsonEditor', 'toggleWbJsonEditor',
  ];
  for (const fn of actionsToCheck) {
    assert.equal(typeof sb[fn], 'function', `${fn} must exist on globalThis`);
  }
});

test('navigation, stats heatmap panic/failure, refreshStats hidden guard, fetch race guard, and openPlatformPage', async () => {
  const proxyHtml = readUi('ui-src/partials/pages/proxy.html');
  assert.equal(/onclick="window\.activateProxyPanel/.test(proxyHtml), false);
  const navJs = readUi('ui/assets/scripts/shell/navigation.js');
  assert.equal(/\.proxy-console-tab[\s\S]{0,120}addEventListener/.test(navJs), false);
  const factoryJs = readUi('ui/assets/scripts/platforms/models_table_factory.js');
  assert.equal(/_orig\s*=\s*openPlatformPage/.test(factoryJs), false);

  // stats heatmap panicPanel & showStatsFailure
  const statsSb = createBaseSandbox({
    escapeText: s => String(s ?? ''),
  });
  statsSb._elements.set('statsTokenHeatmap', createFakeEl('statsTokenHeatmap'));
  statsSb._elements.set('mainTrendEcharts', createFakeEl('mainTrendEcharts'));
  statsSb._elements.set('statsRankTable', createFakeEl('statsRankTable'));
  statsSb._elements.set('statsSourcesDeck', createFakeEl('statsSourcesDeck'));
  statsSb._elements.set('statsRecentTbody', createFakeEl('statsRecentTbody'));
  loadScriptsIntoSandbox(statsSb, ['ui/assets/scripts/stats/page-controller.js']);
  statsSb.panicPanel('热力图', new Error('boom'));
  assert.match(statsSb._elements.get('statsTokenHeatmap').innerHTML, /热力图渲染失败：boom/);
  statsSb._elements.get('statsTokenHeatmap').innerHTML = 'stale';
  statsSb.showStatsFailure(new Error('offline'));
  assert.match(statsSb._elements.get('statsTokenHeatmap').innerHTML, /统计加载失败：offline/);

  // refreshStats document.hidden guard
  let statsCalls = 0;
  const lifeSb = createBaseSandbox({
    proxyRunning: true,
    _toggling: false,
    invoke: async cmd => {
      if (cmd === 'get_stats') statsCalls += 1;
      return { recent: [], rate: {}, requests: 0, totalTokens: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, errors: 0 };
    },
    renderProxyOverviewRecentStream: () => {},
    setText: () => {},
    setBar: () => {},
    fmtNum: n => String(n),
    pctOf: () => 0,
    updateHealthPill: () => {},
  });
  loadScriptsIntoSandbox(lifeSb, ['ui/assets/scripts/runtime/proxy-lifecycle.js']);
  lifeSb.document.hidden = true;
  await lifeSb.refreshStats();
  assert.equal(statsCalls, 0);
  lifeSb.document.hidden = false;
  await lifeSb.refreshStats();
  assert.equal(statsCalls, 1);

  // shared_config_editor race guard: slow A loses to fast B
  const editorSb = createBaseSandbox();
  loadScriptsIntoSandbox(editorSb, ['ui/assets/scripts/platforms/shared_config_editor.js']);
  let seq = 0;
  let loadingState = null;
  const applied = [];
  const pSlow = editorSb.runRaceGuardedModelFetch({
    getSeq: () => seq,
    bumpSeq: () => ++seq,
    setLoadingFn: v => { loadingState = v; },
    fetcher: () => new Promise(r => setTimeout(() => r(['old']), 30)),
    onSuccess: res => applied.push(res),
  });
  const pFast = editorSb.runRaceGuardedModelFetch({
    getSeq: () => seq,
    bumpSeq: () => ++seq,
    setLoadingFn: v => { loadingState = v; },
    fetcher: () => new Promise(r => setTimeout(() => r(['new']), 5)),
    onSuccess: res => applied.push(res),
  });
  const [resSlow, resFast] = await Promise.all([pSlow, pFast]);
  assert.equal(resSlow.stale, true);
  assert.equal(resFast.stale, false);
  assert.deepEqual(applied, [['new']]);
  assert.equal(loadingState, false);

  // openPlatformPage background refresh for claude-code / codex / opencode / grok
  const refreshedPlatforms = [];
  const navSb = createBaseSandbox({
    refreshPlatforms: async opts => { refreshedPlatforms.push(opts); },
    renderGrokPageStatus: () => {},
    platformInfoOf: () => ({}),
    platformDef: () => ({ name: 'x' }),
    platformProviderList: () => [],
  });
  navSb._elements.set('page-platform-claude-code', createFakeEl('page-platform-claude-code'));
  navSb._elements.set('page-platform-codex', createFakeEl('page-platform-codex'));
  navSb._elements.set('page-platform-opencode', createFakeEl('page-platform-opencode'));
  navSb._elements.set('page-platform-grok', createFakeEl('page-platform-grok'));
  loadScriptsIntoSandbox(navSb, ['ui/assets/scripts/platforms/cursor_add.js']);
  for (const plat of ['claude-code', 'codex', 'opencode', 'grok']) {
    navSb.openPlatformPage(plat);
  }
  assert.equal(refreshedPlatforms.length, 4);
  assert.deepStrictEqual({ ...refreshedPlatforms[0] }, { silent: true, force: true, reloadProviders: true });
});
