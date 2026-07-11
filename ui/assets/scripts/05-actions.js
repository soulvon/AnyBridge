// ES module (P3) — vars on globalThis; functions kept + mirrored for hoist + data-action.
/**
 * 05-actions.js — 中央事件委托（data-action 总线）
 *
 * 约定：
 * - data-action="fnName" 调用全局 window[fnName]
 * - data-args='["a",true]' JSON 数组参数（可选）
 * - data-arg="string" 单字符串参数（可选，与 data-args 二选一）
 * - data-pass-event 将 event 作为最后一个参数传入
 * - data-pass-value 将 el.value 作为参数
 * - data-pass-checked 将 el.checked 作为参数
 * - data-pass-this 将 el 作为第一个参数
 * - data-stop / data-prevent 调用 stopPropagation / preventDefault
 * - data-only-self 仅当 event.target === el 时触发（遮罩关闭）
 * - data-click-id="domId" 触发 document.getElementById(domId).click()
 * - data-clear-id="domId" 清空 input value
 * - data-assign="globalVar" + 可选 data-action：先赋 el.value 再调用
 * - data-set="globalVar" + data-set-value="x"：先赋固定值再调用
 * - data-action-call="fn('a',true)"：解析简单调用串（动态模板场景）
 * - data-events="click|change|input|keydown" 声明监听事件（click 可省略）
 * - data-action-chain='[{"fn":"a","args":[]}]' 多步调用
 * - data-actions='{"click":{"action":"fn","args":[],"passEvent":true},"keydown":{...}}'
 *   同一元素多事件不同处理（优先于 data-action）
 * - data-key="Enter" 仅匹配指定 key（keydown）
 *
 * 兼容：仍带 onclick/onchange 的元素由浏览器原生处理，本总线跳过，避免双触发。
 */
(function initActionBus() {
  if (window.__anybridgeActionBusBound) return;
  window.__anybridgeActionBusBound = true;

  // 仅 stopPropagation 等无业务函数场景
  window.__noop = function __noop() {};

  function parseArgs(el) {
    if (el.hasAttribute('data-args')) {
      const raw = el.getAttribute('data-args');
      try {
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) {
          console.error('[actions] data-args must be JSON array:', raw);
          return null;
        }
        return parsed;
      } catch (e) {
        console.error('[actions] invalid data-args JSON:', raw, e);
        return null;
      }
    }
    if (el.hasAttribute('data-arg')) {
      return [el.getAttribute('data-arg')];
    }
    return [];
  }

  function resolveHandler(name) {
    if (!name) return null;
    if (typeof window[name] === 'function') return window[name];
    return null;
  }

  function parseActionsMap(el) {
    if (!el.hasAttribute('data-actions')) return null;
    try {
      const map = JSON.parse(el.getAttribute('data-actions'));
      return map && typeof map === 'object' ? map : null;
    } catch (e) {
      console.error('[actions] invalid data-actions JSON', e);
      return null;
    }
  }

  function hasEvent(el, name) {
    const map = parseActionsMap(el);
    if (map) return Object.prototype.hasOwnProperty.call(map, name);

    const declared = el.getAttribute('data-events');
    if (!declared) {
      // 未声明时：click 默认；表单控件的 change 默认；其余需显式 data-events
      if (name === 'click') return true;
      if (name === 'change') {
        const tag = (el.tagName || '').toLowerCase();
        return ['input', 'select', 'textarea'].includes(tag);
      }
      // data-action-call / data-set 默认也响应 click
      if (name === 'input') return false;
      return false;
    }
    return declared.split(/\s+/).includes(name);
  }

  function invokeStep(step, el, event) {
    const fnName = step.fn || step.action;
    const fn = resolveHandler(fnName);
    if (!fn) {
      console.error('[actions] missing handler:', fnName);
      return;
    }
    const args = Array.isArray(step.args) ? step.args.slice() : [];
    if (step.passThis) args.unshift(el);
    if (step.passValue) args.push(el.value);
    if (step.passChecked) args.push(el.checked);
    if (step.passEvent) args.push(event);
    try {
      fn.apply(el, args);
    } catch (err) {
      console.error('[actions] handler error:', fnName, err);
    }
  }

  /**
   * 解析简单调用串：fn() / fn('a') / fn("a", true, 1)
   * 不支持嵌套调用、对象字面量、表达式。
   */
  function parseCallString(raw) {
    const code = String(raw || '').trim().replace(/;+\s*$/, '');
    if (!code) return null;
    const m = code.match(/^([A-Za-z_$][\w$]*)\s*\((.*)\)\s*$/);
    if (!m) return null;
    const name = m[1];
    const argStr = m[2].trim();
    if (!argStr) return { name, args: [] };

    const args = [];
    let cur = '';
    let depth = 0;
    let quote = null;
    for (let i = 0; i < argStr.length; i++) {
      const ch = argStr[i];
      if (quote) {
        cur += ch;
        if (ch === quote && argStr[i - 1] !== '\\') quote = null;
        continue;
      }
      if (ch === "'" || ch === '"') {
        quote = ch;
        cur += ch;
        continue;
      }
      if (ch === '(' || ch === '{' || ch === '[') {
        depth++;
        cur += ch;
        continue;
      }
      if (ch === ')' || ch === '}' || ch === ']') {
        depth--;
        cur += ch;
        continue;
      }
      if (ch === ',' && depth === 0) {
        args.push(cur.trim());
        cur = '';
        continue;
      }
      cur += ch;
    }
    if (cur.trim()) args.push(cur.trim());

    const parsed = [];
    for (const a of args) {
      if (a === 'true') parsed.push(true);
      else if (a === 'false') parsed.push(false);
      else if (a === 'null') parsed.push(null);
      else if (/^-?\d+(\.\d+)?$/.test(a)) parsed.push(Number(a));
      else if (
        (a.startsWith("'") && a.endsWith("'")) ||
        (a.startsWith('"') && a.endsWith('"'))
      ) {
        parsed.push(a.slice(1, -1));
      } else {
        // 不支持复杂表达式
        return null;
      }
    }
    return { name, args: parsed };
  }

  function invokeCallString(raw, el) {
    const text = String(raw || '').trim();
    if (!text) return; // taken/disabled 等场景可能挂空串
    const call = parseCallString(text);
    if (!call) {
      console.error('[actions] unsupported data-action-call:', raw);
      return;
    }
    const fn = resolveHandler(call.name);
    if (!fn) {
      console.error('[actions] missing handler for data-action-call:', call.name);
      return;
    }
    try {
      fn.apply(el, call.args);
    } catch (err) {
      console.error('[actions] data-action-call error:', call.name, err);
    }
  }

  function applyDataSet(el) {
    if (!el.hasAttribute('data-set')) return;
    const varName = el.getAttribute('data-set');
    if (!varName) return;
    let value = el.getAttribute('data-set-value');
    if (value === null) value = '';
    try {
      window[varName] = value;
    } catch (e) {
      console.error('[actions] data-set failed:', varName, e);
    }
  }

  function runAction(el, event, eventName) {
    if (el.hasAttribute('data-only-self') && event.target !== el) return;

    if (el.hasAttribute('data-prevent')) event.preventDefault();
    if (el.hasAttribute('data-stop')) event.stopPropagation();

    // 多事件映射优先
    const map = parseActionsMap(el);
    if (map) {
      const step = map[eventName];
      if (!step) return;
      if (step.prevent) event.preventDefault();
      if (step.stop) event.stopPropagation();
      if (step.key && event.key !== step.key) return;
      invokeStep(step, el, event);
      return;
    }

    if (el.hasAttribute('data-click-id')) {
      const target = document.getElementById(el.getAttribute('data-click-id'));
      if (target) target.click();
      return;
    }
    if (el.hasAttribute('data-clear-id')) {
      const target = document.getElementById(el.getAttribute('data-clear-id'));
      if (target) target.value = '';
      return;
    }

    if (el.hasAttribute('data-assign')) {
      const varName = el.getAttribute('data-assign');
      if (varName) {
        try {
          window[varName] = el.value;
        } catch (e) {
          console.error('[actions] data-assign failed:', varName, e);
        }
      }
    }

    applyDataSet(el);

    if (el.hasAttribute('data-action-call')) {
      invokeCallString(el.getAttribute('data-action-call'), el);
      return;
    }

    if (el.hasAttribute('data-action-chain')) {
      let chain;
      try {
        chain = JSON.parse(el.getAttribute('data-action-chain'));
      } catch (e) {
        console.error('[actions] invalid data-action-chain', e);
        return;
      }
      if (!Array.isArray(chain)) return;
      for (const step of chain) {
        invokeStep(step, el, event);
      }
      return;
    }

    const action = el.getAttribute('data-action');
    if (!action || action === '__noop') return;

    const fn = resolveHandler(action);
    if (!fn) {
      console.error('[actions] missing global handler:', action);
      return;
    }

    const args = parseArgs(el);
    if (args === null) return;

    if (el.hasAttribute('data-pass-this')) args.unshift(el);
    if (el.hasAttribute('data-pass-value')) args.push(el.value);
    if (el.hasAttribute('data-pass-checked')) args.push(el.checked);
    if (el.hasAttribute('data-pass-event')) args.push(event);

    try {
      fn.apply(el, args);
    } catch (err) {
      console.error('[actions] handler error:', action, err);
    }
  }

  function findActionEl(start, attrList) {
    let node = start;
    while (node && node !== document && node !== document.documentElement) {
      if (node.nodeType === 1) {
        for (const attr of attrList) {
          if (node.hasAttribute(attr)) return node;
        }
      }
      node = node.parentElement;
    }
    return null;
  }

  function stillHasNative(el, type) {
    if (type === 'click' && el.hasAttribute('onclick')) return true;
    if (type === 'change' && el.hasAttribute('onchange')) return true;
    if (type === 'input' && el.hasAttribute('oninput')) return true;
    if (type === 'keydown' && el.hasAttribute('onkeydown')) return true;
    return false;
  }

  const ACTION_ATTRS = [
    'data-action',
    'data-actions',
    'data-action-chain',
    'data-action-call',
    'data-click-id',
    'data-clear-id',
    'data-assign',
    'data-set',
  ];

  function bind(type) {
    document.addEventListener(type, (event) => {
      const el = findActionEl(event.target, ACTION_ATTRS);
      if (!el) return;
      if (!hasEvent(el, type)) return;
      if (stillHasNative(el, type)) return;
      if (type === 'keydown' && el.hasAttribute('data-key') && event.key !== el.getAttribute('data-key')) {
        return;
      }
      runAction(el, event, type);
    });
  }

  bind('click');
  bind('change');
  bind('input');
  bind('keydown');
})();
