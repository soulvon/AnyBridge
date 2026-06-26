// codex-desktop-inject.js
//
// Builds the renderer-side injection script that unblocks custom models in
// the Codex Desktop (Electron) model picker. The Statsig server-side gate
// `useHiddenModels` (gate id 107580212) filters non-whitelisted models out
// of the picker even when config.toml + models_cache.json are correct.
//
// Six patch points (CC-Switch spec §4.14):
//   1. Statsig firstInstance dynamic config 107580212 -> patch getDynamicConfig + _store
//   2. app-server sendRequest('list-models-for-host') → inject custom models
//   3. MCP model/list → inject custom models
//   4. Response.prototype.json for /models → inject custom models
//   5. React Fiber memoizedState.models (via __reactContainer$ / __codexRoot) → splice
//   6. auth.setAuthMethod('chatgpt') → unlock plugin entry
//
// Delayed strategy (§4.15): early setInterval crashed the renderer. We run
// patches at 2s/5s/10s plus a MutationObserver watching for [data-model-picker].
//
// Idempotency guard: window.__ccSwitchCodexModelPickerUnlockV6 (anti-cache; must
// match PATCH_KEY below and isAlreadyInjected() in codex-desktop-cdp.js).
//
// Ported from CC-Switch spec §4.14-4.15 and CodexPlusPlus renderer-inject.js
// fiber-walking patterns (L646-706).
//
// 2026-06-26 fix: Statsig instance is __STATSIG__.firstInstance (not the module).
//   Gate 107580212 is a DYNAMIC CONFIG read via getDynamicConfig() — checkGate/
//   getFeatureGate are patched only as secondary fallbacks. React 18+ uses
//   __reactContainer$ prefix (not __reactFiber); __codexRoot._internalRoot.current
//   is the fiber root.
//
// 2026-06-27 fix: models_cache.json is no longer written here. The Rust side
//   (codex_desktop.rs write_models_cache) writes it before Codex starts, with
//   original slugs (no prefix) + an anybridge_managed marker. This module only
//   does runtime CDP injection (Statsig/React/fetch), using the same slugs.

const PATCH_KEY = '__ccSwitchCodexModelPickerUnlockV6';
const INJECT_VERSION = '20260627-v6-proven';

/**
 * @param {Array<{slug:string, display_name?:string, description?:string, context_window?:number}>} models
 *   Codex-internal model objects (same shape as models_cache.json entries).
 * @returns {string} JavaScript source to evaluate / inject via CDP.
 */
export function buildInjectionScript(models) {
  const safeModels = Array.isArray(models) ? models : [];
  const modelsJson = JSON.stringify(safeModels);
  return `(function(){
  if (window.${PATCH_KEY}) { return 'already'; }
  window.${PATCH_KEY} = true;
  window.__anybridgeInjectVersion = '${INJECT_VERSION}';
  var CUSTOM_MODELS = ${modelsJson};
  if (!CUSTOM_MODELS || !CUSTOM_MODELS.length) { return 'no-models'; }

  // OpenAI /v1/models list-format objects (for HTTP response patching).
  var CUSTOM_MODELS_API = CUSTOM_MODELS.map(function(m){
    return { id: m.slug, object: 'model', created: 0, owned_by: 'anybridge' };
  });
  var CUSTOM_SLUGS = CUSTOM_MODELS.map(function(m){ return m.slug; });

  function mergeUnique(existing, additions, keyFn){
    var seen = {};
    (existing||[]).forEach(function(e){ seen[keyFn(e)] = true; });
    var result = (existing||[]).slice();
    additions.forEach(function(a){
      if (!seen[keyFn(a)]) { seen[keyFn(a)] = true; result.push(a); }
    });
    return result;
  }

  // ── Patch 1: Statsig firstInstance dynamic config 107580212 (model availability) ──
  // __STATSIG__ is the SDK module (exports), NOT the instance.
  // The actual client instance lives at __STATSIG__.firstInstance.
  // Gate 107580212 is a DYNAMIC CONFIG (not a simple boolean gate).
  // It lives in _store._values.dynamic_configs, NOT feature_gates.
  // Codex calls getDynamicConfig('107580212') to read the model list.
  // Value structure: { available_models: [...], use_hidden_models: bool, default_model: string }
  function patchStatsigGate(){
    try {
      var statsig = window.__STATSIG__;
      if (!statsig) return;
      // Build the dynamic config value with custom model slugs
      var configValue = {
        available_models: CUSTOM_SLUGS.slice(),
        use_hidden_models: false,
        default_model: CUSTOM_SLUGS[0] || 'gpt-5.5'
      };
      // Full wrapper object matching Statsig internal format
      var configWrapper = {
        name: '107580212',
        value: configValue,
        rule_id: 'cc-override',
        group: 'cc-override',
        is_device_based: false,
        passed: true,
        id_type: 'userID',
        secondary_exposures: []
      };
      // Patch both firstInstance and instance() result for robustness
      var instances = [];
      if (statsig.firstInstance && !statsig.firstInstance.__ccPatched) {
        instances.push(statsig.firstInstance);
      }
      try {
        var inst = statsig.instance && statsig.instance();
        if (inst && !inst.__ccPatched && instances.indexOf(inst) === -1) {
          instances.push(inst);
        }
      } catch(e){}
      if (Array.isArray(statsig.instances)) {
        statsig.instances.forEach(function(item){
          var obj = item && item.instance ? item.instance : item;
          if (obj && !obj.__ccPatched && instances.indexOf(obj) === -1) {
            instances.push(obj);
          }
        });
      }
      for (var i = 0; i < instances.length; i++) {
        var target = instances[i];
        // --- Dynamic Config patches (PRIMARY: Codex reads from here) ---
        if (typeof target.getDynamicConfig === 'function') {
          var origGetDC = target.getDynamicConfig;
          target.getDynamicConfig = function(name){
            if (String(name) === '107580212') return configWrapper;
            return origGetDC.apply(this, arguments);
          };
        }
        if (typeof target._getDynamicConfigImpl === 'function') {
          var origDCImpl = target._getDynamicConfigImpl;
          target._getDynamicConfigImpl = function(name){
            if (String(name) === '107580212') return configWrapper;
            return origDCImpl.apply(this, arguments);
          };
        }
        // --- Feature Gate patches (secondary, for robustness) ---
        if (typeof target.checkGate === 'function') {
          var origCheckGate = target.checkGate;
          target.checkGate = function(name){
            if (String(name) === '107580212') return configValue;
            return origCheckGate.apply(this, arguments);
          };
        }
        if (typeof target.getFeatureGate === 'function') {
          var origGetGate = target.getFeatureGate;
          target.getFeatureGate = function(name){
            if (String(name) === '107580212') return configWrapper;
            return origGetGate.apply(this, arguments);
          };
        }
        if (typeof target._getFeatureGateImpl === 'function') {
          var origImpl = target._getFeatureGateImpl;
          target._getFeatureGateImpl = function(name){
            if (String(name) === '107580212') return configWrapper;
            return origImpl.apply(this, arguments);
          };
        }
        // --- MemoCache pre-population ---
        if (target._memoCache && typeof target._memoCache === 'object') {
          function djb2(str) {
            var hash = 5381;
            for (var j = 0; j < str.length; j++) {
              hash = ((hash << 5) + hash) + str.charCodeAt(j);
              hash = hash & hash;
            }
            return (hash >>> 0);
          }
          target._memoCache['c|' + djb2('107580212')] = configWrapper;
          target._memoCache['g|' + djb2('107580212')] = configWrapper;
        }
        // --- Direct _store injection ---
        if (target._store && target._store._values) {
          var inner = target._store._values._values || target._store._values;
          if (inner.dynamic_configs) {
            inner.dynamic_configs['107580212'] = configWrapper;
          }
        }
        target.__ccPatched = true;
      }
    } catch(e){}
  }

  // ── Patch 2: Model descriptor builder ─────────────────────────────
  function descriptorFor(name){
    return {
      model: name, id: name, slug: name, name: name, displayName: name,
      hidden: false, defaultReasoningEffort: 'medium',
      supportedReasoningEfforts: ['low','medium','high','xhigh'].map(function(e){
        return {reasoningEffort: e, description: e + ' effort'};
      })
    };
  }
  function patchModelArray(arr){
    if (!Array.isArray(arr)) return false;
    var seen = {};
    arr.forEach(function(x){
      if (x && typeof x === 'object') seen[x.model||x.slug||x.id||x.name] = true;
    });
    CUSTOM_SLUGS.forEach(function(name){
      if (!seen[name]) arr.push(descriptorFor(name));
      else {
        var item = arr.find(function(x){ return x && (x.model===name||x.slug===name); });
        if (item && item.hidden !== false) item.hidden = false;
      }
    });
    return true;
  }
  function patchModelContainer(v){
    if (!v || typeof v !== 'object') return;
    if (Array.isArray(v)) { patchModelArray(v); return; }
    if (Array.isArray(v.models)) patchModelArray(v.models);
    if (Array.isArray(v.data)) patchModelArray(v.data);
    if (Array.isArray(v.available_models)) {
      CUSTOM_SLUGS.forEach(function(n){ if (v.available_models.indexOf(n)===-1) v.available_models.push(n); });
    }
    if (v.use_hidden_models !== false) v.use_hidden_models = false;
    if (v.useHiddenModels !== false) v.useHiddenModels = false;
  }

  // ── Patch 2b: app-server via webpack module import ─────────────────
  var modulePromises = {};
  function loadAppModule(prefix){
    if (modulePromises[prefix]) return modulePromises[prefix];
    var p = (async function(){
      try {
        var webp = await import('webpack:///webpack/container/reference/');
        if (!webp) return null;
        for (var k of Object.keys(webp)) {
          if (k.startsWith(prefix)) { try { return await webp[k](); } catch(e){} }
        }
      } catch(e){}
      return null;
    })();
    modulePromises[prefix] = p;
    return p;
  }
  function patchRequestClient(client){
    if (!client || typeof client.sendRequest !== 'function') return false;
    if (client.__ccReqPatched) return true;
    var orig = client.sendRequest.bind(client);
    client.sendRequest = async function(method, params, opts){
      var r = await orig(method, params, opts);
      var m = typeof method === 'string' ? method : (params && params.method) || '';
      if (m === 'list-models-for-host') {
        try {
          if (Array.isArray(r)) patchModelArray(r);
          if (r && Array.isArray(r.data)) patchModelArray(r.data);
          if (r && Array.isArray(r.models)) patchModelArray(r.models);
          patchModelContainer(r);
        } catch(e){}
      }
      return r;
    };
    client.__ccReqPatched = true;
    return true;
  }
  async function installAppServerPatch(){
    try {
      var mod = await loadAppModule('app-server-manager-signals-');
      if (!mod) return;
      for (var c of Object.values(mod).filter(function(x){ return x && typeof x === 'object'; })) {
        patchRequestClient(c);
        if (typeof c.sendRequest !== 'function' && typeof c.get === 'function') {
          try { patchRequestClient(c.get()); } catch(e){}
        }
      }
    } catch(e){}
  }
  // Fallback: try window.__appServer directly
  function patchAppServer(){
    try {
      var srv = window.__appServer;
      if (!srv) return;
      patchRequestClient(srv);
    } catch(e){}
  }

  // ── Patch 3: MCP model/list intercept ───────────────────────────────
  // The MCP transport may expose a request handler; intercept responses
  // for method 'model/list' and splice in custom models.
  function patchMcp(){
    try {
      var mcp = window.__mcp__ || window.__mcpClient;
      if (!mcp || mcp.__ccPatched) return;
      var orig = mcp.request || mcp.sendRequest;
      if (typeof orig !== 'function') return;
      mcp.request = async function(msg){
        var result = await orig.apply(this, arguments);
        try {
          if (msg && (msg.method === 'model/list' || msg.method === 'models/list') && result) {
            var arr = result.models || result.data || result;
            if (Array.isArray(arr)) {
              var merged = mergeUnique(arr, CUSTOM_MODELS, function(m){ return m.slug || m.id; });
              if (result.models) result.models = merged;
              else if (result.data) result.data = merged;
            }
          }
        } catch(e){}
        return result;
      };
      mcp.__ccPatched = true;
    } catch(e){}
  }

  // ── Patch 4: Response.prototype.json for /models responses ─────────
  function patchResponseJson(){
    try {
      if (Response.prototype.__ccPatched) return;
      var origJson = Response.prototype.json;
      Response.prototype.json = async function(){
        var result = await origJson.apply(this, arguments);
        try {
          if (result && typeof result === 'object') {
            patchModelContainer(result);
            if (result.data && Array.isArray(result.data)) patchModelArray(result.data);
            if (result.models && Array.isArray(result.models)) patchModelArray(result.models);
          }
        } catch(e){}
        return result;
      };
      Response.prototype.__ccPatched = true;
    } catch(e){}
  }

  // ── Patch 4b: fetch interception (fix thinking.type etc.) ──────────
  function installFetchPatch(){
    try {
      if (window.__ccFetchPatched || typeof fetch !== 'function') return;
      window.__ccFetchPatched = true;
      var origFetch = window.fetch;
      window.fetch = async function(input, init){
        try {
          var url = typeof input === 'string' ? input : (input && input.url) || '';
          var isApi = url.indexOf('/responses') !== -1 || url.indexOf('/chat/completions') !== -1;
          if (isApi && init && init.body && typeof init.body === 'string') {
            var body = JSON.parse(init.body);
            var modified = false;
            if (body.thinking && typeof body.thinking === 'object') {
              if (body.thinking.type === 'enabled') { body.thinking.type = 'adaptive'; modified = true; }
            }
            if (body.reasoning && typeof body.reasoning === 'object') {
              if (body.reasoning.type === 'enabled') { body.reasoning.type = 'adaptive'; modified = true; }
            }
            if (modified) init = Object.assign({}, init, { body: JSON.stringify(body) });
          }
        } catch(e){}
        return origFetch.call(this, input, init);
      };
    } catch(e){}
  }

  // ── Patch 5: React Fiber memoizedState.models ──────────────────────
  // React 18+ uses __reactContainer$ prefix on the root element (not __reactFiber).
  // Additionally, __codexRoot._internalRoot.current is the definitive fiber root.
  function reactFiberFrom(el){
    if (!el) return null;
    // Try React 18+ container key first, then legacy __reactFiber
    var key = Object.keys(el).find(function(k){
      return k.indexOf('__reactContainer') === 0 || k.indexOf('__reactFiber') === 0;
    });
    return key ? el[key] : null;
  }

  function getFiberRoot(){
    // Primary: __codexRoot._internalRoot.current (definitive React 18 fiber root)
    if (window.__codexRoot && window.__codexRoot._internalRoot && window.__codexRoot._internalRoot.current) {
      return window.__codexRoot._internalRoot.current;
    }
    // Fallback: __reactContainer$ on #root
    var root = document.getElementById('root') || document.querySelector('#__next') || document.body;
    return reactFiberFrom(root);
  }

  function patchReactState(){
    try {
      var fiber = getFiberRoot();
      if (!fiber) return;
      var visited = {};
      var stack = [fiber];
      var maxNodes = 10000;
      var count = 0;
      while (stack.length && count < maxNodes) {
        count++;
        var current = stack.pop();
        if (!current) continue;
        var uid = (current.tag || 0) + '_' + (current.index || 0);
        if (visited[uid]) continue;
        visited[uid] = true;
        try {
          // Check class component stateNode.state.models
          if (current.stateNode && current.stateNode !== document.getElementById('root')) {
            var sn = current.stateNode;
            if (sn.state && sn.state.models && Array.isArray(sn.state.models)) {
              sn.state.models = mergeUnique(sn.state.models, CUSTOM_MODELS, function(m){ return m.slug || m.id; });
            }
          }
          // Walk hook chain (function components)
          var state = current.memoizedState;
          var hookIdx = 0;
          while (state && hookIdx < 30) {
            if (state.memoizedState && Array.isArray(state.memoizedState)) {
              var arr = state.memoizedState;
              if (arr.length > 0 && arr[0] && typeof arr[0] === 'object' && (arr[0].slug || arr[0].id)) {
                state.memoizedState = mergeUnique(arr, CUSTOM_MODELS, function(m){ return m.slug || m.id; });
              }
            }
            if (state.queue && state.queue.lastRenderedState && Array.isArray(state.queue.lastRenderedState)) {
              var qa = state.queue.lastRenderedState;
              if (qa.length > 0 && qa[0] && typeof qa[0] === 'object' && (qa[0].slug || qa[0].id)) {
                state.queue.lastRenderedState = mergeUnique(qa, CUSTOM_MODELS, function(m){ return m.slug || m.id; });
              }
            }
            if (state.models && Array.isArray(state.models)) {
              state.models = mergeUnique(state.models, CUSTOM_MODELS, function(m){ return m.slug || m.id; });
            }
            state = state.next;
            hookIdx++;
          }
          // Check memoizedProps.models
          if (current.memoizedProps && current.memoizedProps.models && Array.isArray(current.memoizedProps.models)) {
            current.memoizedProps.models = mergeUnique(current.memoizedProps.models, CUSTOM_MODELS, function(m){ return m.slug || m.id; });
          }
        } catch(e){}
        if (current.child) stack.push(current.child);
        if (current.sibling) stack.push(current.sibling);
      }
    } catch(e){}
  }

  // ── Patch 6: auth.setAuthMethod('chatgpt') ─────────────────────────
  // Walk fiber tree from an element upward to find the auth context value,
  // then call setAuthMethod('chatgpt') to unlock plugin entries.
  function authContextValueFrom(el){
    var fiber = reactFiberFrom(el);
    if (!fiber) {
      // Also try walking up from __reactInternalInstance (older pattern)
      var key = Object.keys(el).find(function(k){ return k.indexOf('__reactInternalInstance') === 0 || k.indexOf('__reactFiber') === 0 || k.indexOf('__reactContainer') === 0; });
      if (key) fiber = el[key];
    }
    while (fiber) {
      var vals = [fiber.memoizedProps && fiber.memoizedProps.value, fiber.pendingProps && fiber.pendingProps.value];
      for (var i = 0; i < vals.length; i++) {
        var v = vals[i];
        if (v && typeof v === 'object' && typeof v.setAuthMethod === 'function' && 'authMethod' in v) {
          return v;
        }
      }
      fiber = fiber.return;
    }
    return null;
  }

  function patchAuthMethod(){
    try {
      // Try a few likely selectors for elements that carry the auth context.
      var candidates = document.querySelectorAll('button, [role="button"], nav, header, [data-auth]');
      for (var i = 0; i < candidates.length; i++) {
        var auth = authContextValueFrom(candidates[i]);
        if (auth && auth.authMethod !== 'chatgpt') {
          auth.setAuthMethod('chatgpt');
          return true;
        }
      }
    } catch(e){}
    return false;
  }

  // ── Run all patches ────────────────────────────────────────────────
  function runAll(){
    patchStatsigGate();
    patchAppServer();
    patchMcp();
    patchResponseJson();
    installFetchPatch();
    patchReactState();
    patchAuthMethod();
  }

  // Immediate run
  patchStatsigGate();
  patchResponseJson();
  installFetchPatch();
  void installAppServerPatch();

  // Delayed runs: 2s / 5s / 10s
  [2000, 5000, 10000].forEach(function(delay){
    setTimeout(function(){
      patchStatsigGate();
      patchAppServer();
      void installAppServerPatch();
    }, delay);
  });

  // MutationObserver: 200ms debounce, re-patch when picker opens
  try {
    var debounceTimer = null;
    var observer = new MutationObserver(function(){
      if (debounceTimer) return;
      debounceTimer = setTimeout(function(){
        debounceTimer = null;
        try {
          var picker = document.querySelector('[role="dialog"], [role="menu"], [data-radix-popper-content-wrapper]');
          if (picker) {
            patchStatsigGate();
            patchAuthMethod();
            void installAppServerPatch();
          }
        } catch(e){}
      }, 200);
    });
    observer.observe(document.body, { childList: true, subtree: true });
    setTimeout(function(){ observer.disconnect(); }, 120000);
  } catch(e){}

  // Lightweight Statsig refresh (5s interval)
  setInterval(function(){ patchStatsigGate(); }, 5000);

  return 'ok';
})();`;
}
