/**
 * 供应商多密钥池
 *
 * 语义：编辑页上方输入框是「当前生效密钥」，这里维护候选池。
 * - 走本地代理时，整池交给路由按请求轮换（sidecar provider-pool 已有逻辑）；
 * - 不走代理时，点「设为当前」即切换生效密钥，保存后同步到各平台配置。
 *
 * 池里永远不含当前密钥：后端 normalize_provider_api_keys 负责把当前密钥
 * 插到池首并去重，前端只维护「除了当前之外的那几把」。
 */
import { escAttr } from './ui/dom.js';

globalThis.editorApiKeys = [];

let editorApiKeySeq = 0;
function nextEditorApiKeyId() {
  editorApiKeySeq += 1;
  return `key-${Date.now().toString(36)}-${editorApiKeySeq}`;
}

function editorCurrentKey() {
  const el = document.getElementById('pf-key');
  return el ? String(el.value || '').trim() : '';
}

function renderEditorApiKeys() {
  const listEl = document.getElementById('providerKeysList');
  const emptyEl = document.getElementById('providerKeysEmpty');
  if (!listEl) return;
  const keys = globalThis.editorApiKeys || [];

  listEl.innerHTML = keys
    .map((entry) => {
      const args = escAttr(JSON.stringify([entry.id]));
      const disabled = entry.enabled === false;
      return `
      <div class="provider-key-row${disabled ? ' is-disabled' : ''}">
        <label class="provider-key-enable" title="${disabled ? '启用这把密钥' : '停用这把密钥'}">
          <input type="checkbox" ${disabled ? '' : 'checked'}
            data-action="toggleEditorApiKey" data-args="${args}" data-pass-checked>
        </label>
        <input class="provider-key-label" type="text" placeholder="备注" value="${escAttr(entry.label || '')}"
          data-action="onEditorApiKeyLabel" data-args="${args}" data-pass-value data-events="input">
        <input class="provider-key-value" type="password" placeholder="sk-..." value="${escAttr(entry.key || '')}"
          autocomplete="off"
          data-action="onEditorApiKeyValue" data-args="${args}" data-pass-value data-events="input">
        <button type="button" class="provider-key-use" data-action="useEditorApiKey" data-args="${args}"
          title="把当前生效密钥换成这一把">设为当前</button>
        <button type="button" class="provider-key-remove" data-action="removeEditorApiKey" data-args="${args}"
          title="删除这把密钥" aria-label="删除这把密钥">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"
            stroke-linecap="round" stroke-linejoin="round">
            <path d="M3 6h18"></path>
            <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
            <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"></path>
          </svg>
        </button>
      </div>`;
    })
    .join('');

  if (emptyEl) emptyEl.hidden = keys.length > 0;
}

globalThis.loadEditorApiKeys = function (provider) {
  const current = String((provider && provider.apiKey) || '').trim();
  globalThis.editorApiKeys = ((provider && provider.apiKeys) || [])
    .filter((entry) => entry && String(entry.key || '').trim())
    .filter((entry) => String(entry.key || '').trim() !== current)
    .map((entry) => ({
      id: entry.id || nextEditorApiKeyId(),
      label: entry.label || '',
      key: String(entry.key || ''),
      enabled: entry.enabled !== false,
    }));
  renderEditorApiKeys();
};

/** 保存时取池内容；与当前密钥重复的项交给后端去重，这里先剔掉避免闪一下。 */
globalThis.collectEditorApiKeys = function () {
  const current = editorCurrentKey();
  return (globalThis.editorApiKeys || [])
    .map((entry) => ({
      id: entry.id,
      label: String(entry.label || '').trim(),
      key: String(entry.key || '').trim(),
      enabled: entry.enabled !== false,
    }))
    .filter((entry) => entry.key && entry.key !== current);
};

globalThis.addEditorApiKey = function () {
  globalThis.editorApiKeys.push({ id: nextEditorApiKeyId(), label: '', key: '', enabled: true });
  renderEditorApiKeys();
  const rows = document.querySelectorAll('#providerKeysList .provider-key-value');
  const last = rows[rows.length - 1];
  if (last) last.focus();
};

globalThis.removeEditorApiKey = function (id) {
  globalThis.editorApiKeys = (globalThis.editorApiKeys || []).filter((entry) => entry.id !== id);
  renderEditorApiKeys();
};

globalThis.toggleEditorApiKey = function (id, checked) {
  const entry = (globalThis.editorApiKeys || []).find((item) => item.id === id);
  if (!entry) return;
  entry.enabled = !!checked;
  renderEditorApiKeys();
};

globalThis.onEditorApiKeyLabel = function (id, value) {
  const entry = (globalThis.editorApiKeys || []).find((item) => item.id === id);
  if (entry) entry.label = String(value || '');
};

globalThis.onEditorApiKeyValue = function (id, value) {
  const entry = (globalThis.editorApiKeys || []).find((item) => item.id === id);
  if (entry) entry.key = String(value || '');
};

globalThis.useEditorApiKey = function (id) {
  const entry = (globalThis.editorApiKeys || []).find((item) => item.id === id);
  if (!entry) return;
  const key = String(entry.key || '').trim();
  if (!key) {
    addLog('warn', '这把密钥还是空的，填好再设为当前');
    return;
  }

  const currentEl = document.getElementById('pf-key');
  const previous = currentEl ? String(currentEl.value || '').trim() : '';
  if (currentEl) currentEl.value = key;

  // 被替换下来的那把回到池里，不丢用户已经录入的密钥
  globalThis.editorApiKeys = globalThis.editorApiKeys.filter((item) => item.id !== id);
  if (previous && previous !== key) {
    globalThis.editorApiKeys.push({
      id: nextEditorApiKeyId(),
      label: entry.label || '',
      key: previous,
      enabled: true,
    });
  }
  renderEditorApiKeys();
  addLog('ok', '已切换当前密钥，保存后同步到平台配置');
};
