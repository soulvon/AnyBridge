(function initAnyBridgeSandboxBridge(globalObj) {
  'use strict';

  try {
    var search = new URLSearchParams(globalObj.location && globalObj.location.search ? globalObj.location.search : '');
    if (search.get('onboarding') !== '1' && !globalObj.localStorage.getItem('anybridge.onboardingGuideSeen')) {
      globalObj.localStorage.setItem('anybridge.onboardingGuideSeen', '1');
    }
  } catch (_) {}

  var existingInvoke = globalObj.__TAURI__ && globalObj.__TAURI__.core && globalObj.__TAURI__.core.invoke;
  if (typeof existingInvoke === 'function') {
    return;
  }

  var listeners = new Map();

  function dispatchEvent(eventName, payload) {
    var set = listeners.get(eventName);
    if (!set || !set.size) return;
    var eventObj = { event: eventName, id: Date.now(), payload: payload };
    set.forEach(function (handler) {
      try {
        handler(eventObj);
      } catch (err) {
        console.error('[sandbox-bridge] event listener error:', err);
      }
    });
  }

  async function invoke(cmd, args) {
    var res = await globalObj.fetch('/__sandbox/invoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cmd: String(cmd || ''), args: args || {} }),
    });
    var text = await res.text();
    var data = null;
    try {
      data = text ? JSON.parse(text) : {};
    } catch (parseErr) {
      throw new Error('Sandbox IPC 响应解析失败 (' + cmd + '): ' + parseErr.message);
    }
    if (!res.ok || !data || data.ok === false) {
      var errMsg = (data && data.error) ? data.error : ('HTTP ' + res.status + ' on ' + cmd);
      throw new Error(errMsg);
    }
    if (Array.isArray(data.events)) {
      data.events.forEach(function (ev) {
        if (ev && ev.name) dispatchEvent(ev.name, ev.payload);
      });
    }
    return data.result;
  }

  async function listen(eventName, callback) {
    var key = String(eventName || '');
    if (!listeners.has(key)) listeners.set(key, new Set());
    listeners.get(key).add(callback);
    return function unlisten() {
      var set = listeners.get(key);
      if (set) set.delete(callback);
    };
  }

  async function emit(eventName, payload) {
    dispatchEvent(String(eventName || ''), payload);
  }

  var maximized = false;
  var currentWindow = {
    label: 'main',
    minimize: async function () {},
    toggleMaximize: async function () {
      maximized = !maximized;
    },
    maximize: async function () {
      maximized = true;
    },
    unmaximize: async function () {
      maximized = false;
    },
    isMaximized: async function () {
      return maximized;
    },
    close: async function () {},
    hide: async function () {},
    show: async function () {},
    setFocus: async function () {},
    setTitle: async function (title) {
      if (globalObj.document && typeof title === 'string') globalObj.document.title = title;
    },
    onResized: async function () {
      return function () {};
    },
    onCloseRequested: async function () {
      return function () {};
    },
  };

  globalObj.__TAURI__ = {
    __SANDBOX__: true,
    core: {
      invoke: invoke,
    },
    event: {
      listen: listen,
      once: async function (eventName, cb) {
        var unlisten = await listen(eventName, function (ev) {
          unlisten();
          cb(ev);
        });
        return unlisten;
      },
      emit: emit,
    },
    window: {
      getCurrentWindow: function () {
        return currentWindow;
      },
    },
    dialog: {
      save: async function (opts) {
        return (opts && opts.defaultPath) || 'sandbox-export.json';
      },
      open: async function () {
        return null;
      },
    },
    fs: {
      writeTextFile: async function (filePath, content) {
        return invoke('sandbox_write_export', { path: filePath, content: String(content || '') });
      },
    },
  };
})(window);
