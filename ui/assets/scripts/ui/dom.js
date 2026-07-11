/**
 * ui/dom.js — DOM / 文本工具（P4 共享层）
 */
export function forEachElementAlias(id, cb) {
  const seen = new Set();
  const direct = document.getElementById(id);
  if (direct) {
    seen.add(direct);
    cb(direct);
  }
  document.querySelectorAll(`[data-oid="${id}"]`).forEach((el) => {
    if (seen.has(el)) return;
    seen.add(el);
    cb(el);
  });
}

export function setText(id, v) {
  forEachElementAlias(id, (el) => {
    el.textContent = v;
  });
}

export function setBar(id, pct) {
  const el = document.getElementById(id);
  if (!el) return;
  const safe = Number.isFinite(pct) ? Math.max(0, Math.min(100, pct)) : 0;
  el.style.width = safe + '%';
}

export function pctOf(value, total) {
  if (!Number.isFinite(value) || !Number.isFinite(total) || total <= 0) return 0;
  return (value / total) * 100;
}

export function fmtNum(n) {
  if (n == null) return '—';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
  return String(n);
}

export function escapeHtml(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function escAttr(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const g = globalThis;
g.forEachElementAlias = forEachElementAlias;
g.setText = setText;
g.setBar = setBar;
g.pctOf = pctOf;
g.fmtNum = fmtNum;
g.escapeHtml = escapeHtml;
g.escAttr = escAttr;
