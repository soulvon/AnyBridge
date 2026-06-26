// ═══════ 临时手柄调参面板 · 控制器 + 样式 ═══════
// 上线时删除：① 本文件引用 ② index.html 中 #handle-tuner 与 #handle-tuner-toggle

(function () {
  'use strict';

  // ── 调参面板自身样式（与 10-shell.css 隔离，方便一键删除） ──
  const tunerCss = `
#handle-tuner {
  position: fixed;
  right: 20px;
  bottom: 20px;
  width: 340px;
  max-height: 86vh;
  display: flex;
  flex-direction: column;
  background: var(--bg-card, #ffffff);
  border: 1px solid var(--border-strong, rgba(15,23,42,0.12));
  border-radius: 14px;
  box-shadow: 0 18px 48px -16px rgba(15, 23, 42, 0.25), 0 2px 6px rgba(15, 23, 42, 0.08);
  backdrop-filter: blur(20px) saturate(140%);
  -webkit-backdrop-filter: blur(20px) saturate(140%);
  font-family: var(--font-sans, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif);
  color: var(--text-primary, #1f2937);
  z-index: 10050;
  -webkit-app-region: no-drag;
  app-region: no-drag;
  overflow: hidden;
}
#handle-tuner[hidden] { display: none; }

#handle-tuner .ht-header {
  padding: 12px 14px;
  border-bottom: 1px solid var(--border, rgba(15,23,42,0.08));
  display: flex; align-items: center; justify-content: space-between;
  background: linear-gradient(180deg, rgba(148,163,184,0.08), transparent);
}
#handle-tuner .ht-title {
  font-size: 12px; font-weight: 700; letter-spacing: 0.04em;
  display: flex; align-items: center; gap: 8px;
  color: var(--text-secondary, #475569);
}
#handle-tuner .ht-dot {
  width: 7px; height: 7px; border-radius: 50%;
  background: var(--accent, #1261a6);
  box-shadow: 0 0 6px var(--accent, #1261a6);
}
#handle-tuner .ht-actions { display: flex; gap: 4px; }
#handle-tuner .ht-icon-btn {
  width: 26px; height: 26px;
  border: 1px solid var(--border, rgba(15,23,42,0.12));
  border-radius: 6px;
  background: var(--bg-input, rgba(15,23,42,0.04));
  color: var(--text-secondary, #475569);
  font-size: 13px; font-weight: 700; line-height: 1;
  cursor: pointer;
  display: inline-flex; align-items: center; justify-content: center;
  transition: all 120ms cubic-bezier(0.4, 0, 0.2, 1);
  -webkit-app-region: no-drag;
  app-region: no-drag;
}
#handle-tuner .ht-icon-btn:hover {
  background: var(--bg-hover, rgba(15,23,42,0.08));
  color: var(--text-primary, #1f2937);
  border-color: var(--border-strong, rgba(15,23,42,0.18));
}

#handle-tuner .ht-body {
  padding: 10px 14px 14px;
  overflow-y: auto;
  flex: 1 1 auto;
  scrollbar-width: thin;
}
#handle-tuner .ht-section { margin-top: 10px; }
#handle-tuner .ht-section:first-child { margin-top: 0; }
#handle-tuner .ht-section-title {
  font-size: 10px; font-weight: 800; letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--text-muted, #94a3b8);
  margin-bottom: 6px;
}

#handle-tuner .ht-row {
  display: grid;
  grid-template-columns: 56px 1fr 56px;
  align-items: center;
  gap: 8px;
  margin-bottom: 5px;
}
#handle-tuner .ht-row.ht-row-check { grid-template-columns: 56px 1fr; }
#handle-tuner .ht-row label,
#handle-tuner .ht-color-label {
  font-size: 11px; color: var(--text-secondary, #475569);
  font-weight: 600;
}
#handle-tuner .ht-row input[type="range"],
#handle-tuner .ht-color-row input[type="range"] {
  width: 100%; height: 4px;
  accent-color: var(--accent, #1261a6);
  cursor: pointer;
}
#handle-tuner .ht-row input[type="number"],
#handle-tuner .ht-row select {
  width: 100%;
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 11px;
  padding: 3px 6px;
  border: 1px solid var(--border, rgba(15,23,42,0.12));
  border-radius: 5px;
  background: var(--bg-input, rgba(15,23,42,0.04));
  color: var(--text-primary, #1f2937);
  text-align: right;
  outline: none;
  -webkit-app-region: no-drag;
  app-region: no-drag;
}
#handle-tuner .ht-row input[type="number"]:focus,
#handle-tuner .ht-row select:focus {
  border-color: var(--accent, #1261a6);
  box-shadow: 0 0 0 2px rgba(18, 97, 166, 0.12);
}
#handle-tuner .ht-row input[type="checkbox"] {
  width: 16px; height: 16px;
  accent-color: var(--accent, #1261a6);
  cursor: pointer;
  justify-self: start;
}

#handle-tuner .ht-color-row {
  display: grid;
  grid-template-columns: 64px 32px 1fr;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}
#handle-tuner .ht-color-row input[type="color"] {
  width: 32px; height: 24px;
  padding: 0;
  border: 1px solid var(--border, rgba(15,23,42,0.12));
  border-radius: 5px;
  background: transparent;
  cursor: pointer;
}

#handle-tuner-toggle {
  position: fixed;
  left: 20px;
  bottom: 20px;
  width: 44px; height: 44px;
  border-radius: 50%;
  border: 1px solid var(--border-strong, rgba(15,23,42,0.18));
  background: var(--bg-card, #ffffff);
  backdrop-filter: blur(20px) saturate(140%);
  -webkit-backdrop-filter: blur(20px) saturate(140%);
  box-shadow: 0 8px 20px -8px rgba(15, 23, 42, 0.3);
  font-size: 20px;
  color: var(--text-secondary, #475569);
  cursor: pointer;
  display: inline-flex; align-items: center; justify-content: center;
  z-index: 10050;
  transition: all 120ms cubic-bezier(0.4, 0, 0.2, 1);
  -webkit-app-region: no-drag;
  app-region: no-drag;
}
#handle-tuner-toggle:hover {
  transform: translateY(-1px) rotate(30deg);
  color: var(--accent, #1261a6);
  border-color: var(--accent, #1261a6);
}
#handle-tuner-toggle[hidden] { display: none; }

/* 滚动条美化 */
#handle-tuner .ht-body::-webkit-scrollbar { width: 6px; }
#handle-tuner .ht-body::-webkit-scrollbar-thumb {
  background: rgba(148,163,184,0.35);
  border-radius: 3px;
}
#handle-tuner .ht-body::-webkit-scrollbar-thumb:hover {
  background: rgba(148,163,184,0.55);
}

@media (max-width: 720px) {
  #handle-tuner { width: calc(100vw - 40px); }
}
  `;

  // 注入样式
  const styleEl = document.createElement('style');
  styleEl.id = 'handle-tuner-styles';
  styleEl.textContent = tunerCss;
  document.head.appendChild(styleEl);

  // ── 面板开关状态持久化 ──
  const VISIBLE_KEY = 'anybridge.handleTunerVisible';

  function isTunerVisible() {
    try { return localStorage.getItem(VISIBLE_KEY) === '1'; }
    catch (_) { return false; }
  }
  function setTunerVisible(visible) {
    try {
      if (visible) localStorage.setItem(VISIBLE_KEY, '1');
      else localStorage.removeItem(VISIBLE_KEY);
    } catch (_) {}
  }

  // ── 默认值（与 10-shell.css 的 .platform-rail 完全一致） ──
  const DEFAULTS = {
    '--handle-width': '30px',
    '--handle-height': '26px',
    '--handle-justify-self': 'center',
    '--handle-align-self': 'center',
    '--handle-opacity': '0',
    '--handle-opacity-hover': '1',
    '--handle-dot-radius': '1.9px',
    '--handle-dot-color': 'rgba(100, 116, 139, 0.7)',
    '--handle-dot-color-drag': 'rgba(18, 97, 166, 0.85)',
    '--handle-dot-color-dark': 'rgba(148, 163, 184, 0.7)',
    '--handle-dot-color-drag-dark': 'rgba(90, 176, 230, 0.9)',
    '--handle-dot-padding-x': '5px',
    '--handle-dot-padding-y': '5px',
    '--handle-dot-col-spacing': '7px',
    '--handle-dot-row-spacing': '7px',
    '--handle-shadow-on': '1',
    '--handle-shadow-color': 'rgba(15, 23, 42, 0.16)',
    '--handle-shadow-offset-x': '2px',
    '--handle-shadow-offset-y': '2px',
    '--handle-shadow-blur': '1px'
  };

  // ── rgba ↔ {hex, alpha} 转换 ──
  function parseRgba(value) {
    if (!value) return { hex: '#000000', alpha: 1 };
    const m = value.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+))?\s*\)/);
    if (m) {
      const r = parseInt(m[1], 10), g = parseInt(m[2], 10), b = parseInt(m[3], 10);
      const a = m[4] !== undefined ? parseFloat(m[4]) : 1;
      const hex = '#' + [r, g, b].map(n => n.toString(16).padStart(2, '0')).join('');
      return { hex, alpha: a };
    }
    return { hex: '#000000', alpha: 1 };
  }
  function makeRgba(hex, alpha) {
    const h = (hex || '#000000').replace('#', '');
    const r = parseInt(h.substring(0, 2), 16);
    const g = parseInt(h.substring(2, 4), 16);
    const b = parseInt(h.substring(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }

  // ── 读取 rail 当前计算样式 ──
  function getCurrentValue(prop) {
    const rail = document.querySelector('.platform-rail');
    if (!rail) return DEFAULTS[prop];
    return getComputedStyle(rail).getPropertyValue(prop).trim() || DEFAULTS[prop];
  }

  // ── 写回 rail 元素的内联样式（覆盖 CSS 默认值） ──
  function setVar(prop, value) {
    const rail = document.querySelector('.platform-rail');
    if (rail) rail.style.setProperty(prop, value);
  }

  function resetAll() {
    const rail = document.querySelector('.platform-rail');
    if (!rail) return;
    Object.keys(DEFAULTS).forEach(prop => rail.style.removeProperty(prop));
  }

  // ── 把值（带单位）剥出纯数字 ──
  function stripUnit(value) {
    if (value == null) return '';
    return String(value).replace(/[a-z%]+$/i, '').trim();
  }
  function withUnit(value, unit) {
    if (!unit) return String(value);
    const n = stripUnit(value);
    if (n === '' || n === '-') return n + unit;
    return n + unit;
  }

  // ── 初始化面板：把当前值灌入表单 ──
  function syncFormFromRail() {
    const panel = document.getElementById('handle-tuner');
    if (!panel) return;

    // 数值/选择类（带可选单位）
    panel.querySelectorAll('[data-ht]').forEach(input => {
      const prop = input.getAttribute('data-ht');
      const unit = input.getAttribute('data-ht-unit');
      const raw = getCurrentValue(prop);
      const num = stripUnit(raw);
      if (input.tagName === 'SELECT') {
        input.value = raw || DEFAULTS[prop];
      } else {
        input.value = num;
      }
    });
    panel.querySelectorAll('[data-ht-num]').forEach(input => {
      const prop = input.getAttribute('data-ht-num');
      const raw = getCurrentValue(prop);
      input.value = stripUnit(raw);
    });

    // 颜色类：拆出 hex 与 alpha
    panel.querySelectorAll('[data-ht-color]').forEach(input => {
      const prop = input.getAttribute('data-ht-color');
      const raw = getCurrentValue(prop);
      const { hex, alpha } = parseRgba(raw);
      input.value = hex;
      const range = panel.querySelector(`[data-ht-alpha-range="${prop}"]`);
      if (range) range.value = Math.round(alpha * 100);
    });

    // 复选框
    panel.querySelectorAll('[data-ht-toggle]').forEach(input => {
      const prop = input.getAttribute('data-ht-toggle');
      input.checked = getCurrentValue(prop) === '1';
    });
  }

  // ── 绑定事件 ──
  function bindEvents() {
    const panel = document.getElementById('handle-tuner');
    if (!panel) return;

    // range + number 联动
    panel.querySelectorAll('[data-ht]').forEach(input => {
      if (input.tagName === 'SELECT') return;
      const prop = input.getAttribute('data-ht');
      const unit = input.getAttribute('data-ht-unit');
      const numMirror = panel.querySelector(`[data-ht-num="${prop}"]`);
      const handler = () => {
        setVar(prop, withUnit(input.value, unit));
        if (numMirror) numMirror.value = stripUnit(input.value);
      };
      input.addEventListener('input', handler);
    });
    panel.querySelectorAll('[data-ht-num]').forEach(input => {
      const prop = input.getAttribute('data-ht-num');
      const unit = input.getAttribute('data-ht-unit');
      const rangeMirror = panel.querySelector(`[data-ht="${prop}"]`);
      const handler = () => {
        setVar(prop, withUnit(input.value, unit));
        if (rangeMirror) rangeMirror.value = stripUnit(input.value);
      };
      input.addEventListener('input', handler);
    });
    panel.querySelectorAll('select[data-ht]').forEach(input => {
      const prop = input.getAttribute('data-ht');
      input.addEventListener('change', () => setVar(prop, input.value));
    });

    // 颜色 + 透明度联动
    panel.querySelectorAll('[data-ht-color]').forEach(input => {
      const prop = input.getAttribute('data-ht-color');
      const range = panel.querySelector(`[data-ht-alpha-range="${prop}"]`);
      const update = () => {
        const a = (parseInt(range.value, 10) || 0) / 100;
        setVar(prop, makeRgba(input.value, a));
      };
      input.addEventListener('input', update);
      if (range) range.addEventListener('input', update);
    });

    // 阴影开关
    panel.querySelectorAll('[data-ht-toggle]').forEach(input => {
      const prop = input.getAttribute('data-ht-toggle');
      input.addEventListener('change', () => setVar(prop, input.checked ? '1' : '0'));
    });

    // 顶部按钮
    panel.querySelectorAll('[data-ht-action]').forEach(btn => {
      btn.addEventListener('click', () => {
        const action = btn.getAttribute('data-ht-action');
        if (action === 'close') hideTuner();
        else if (action === 'reset') { resetAll(); syncFormFromRail(); }
        else if (action === 'copy') copyFinalCss();
      });
    });

    // 左下角齿轮按钮
    const toggleBtn = document.getElementById('handle-tuner-toggle');
    if (toggleBtn) toggleBtn.addEventListener('click', toggleTuner);

    // Ctrl+Shift+H 切换
    document.addEventListener('keydown', (e) => {
      if (e.ctrlKey && e.shiftKey && (e.key === 'H' || e.key === 'h')) {
        e.preventDefault();
        toggleTuner();
      }
    });
  }

  // ── 复制最终 CSS ──
  function copyFinalCss() {
    const rail = document.querySelector('.platform-rail');
    if (!rail) return;
    const cs = getComputedStyle(rail);
    const lines = ['/* 复制以下片段，替换 ui/assets/styles/10-shell.css 中 .platform-rail 的 --handle-* 段 */'];
    lines.push('.platform-rail {');
    Object.keys(DEFAULTS).forEach(prop => {
      const v = cs.getPropertyValue(prop).trim() || DEFAULTS[prop];
      lines.push(`  ${prop}: ${v};`);
    });
    lines.push('  /* ... 其余属性保持不变 ... */');
    lines.push('}');
    const text = lines.join('\n');
    const fallbackCopy = (txt) => {
      const ta = document.createElement('textarea');
      ta.value = txt;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); } catch (_) {}
      document.body.removeChild(ta);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
    } else {
      fallbackCopy(text);
    }
    if (typeof showBottomToast === 'function') {
      showBottomToast('CSS 已复制到剪贴板，粘贴到 10-shell.css 即可', 'success');
    }
  }

  // ── 显示/隐藏 ──
  function showTuner() {
    const panel = document.getElementById('handle-tuner');
    const toggle = document.getElementById('handle-tuner-toggle');
    if (panel) { panel.hidden = false; syncFormFromRail(); }
    if (toggle) toggle.hidden = true;
    setTunerVisible(true);
  }
  function hideTuner() {
    const panel = document.getElementById('handle-tuner');
    const toggle = document.getElementById('handle-tuner-toggle');
    if (panel) panel.hidden = true;
    if (toggle) toggle.hidden = false;
    setTunerVisible(false);
  }
  function toggleTuner() {
    const panel = document.getElementById('handle-tuner');
    if (!panel) return;
    if (panel.hidden) showTuner();
    else hideTuner();
  }

  // ── 启动 ──
  function boot() {
    bindEvents();
    if (isTunerVisible()) showTuner();
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
