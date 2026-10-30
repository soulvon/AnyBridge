// 行为测试：加载态只能有一个 spinner（坑点 loading-spinner-double）
// 事故：扩展中心 CPA「更新中…」按钮同时有 loadingHtml 自带的圈 + 自造的 .btn-spinner，
// 用户看到两个圈紧挨。这里直接渲染相关函数，断言每个加载态容器内只有一个 spinner。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function readScript(rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}

/** 按花括号配平从源码里截出完整函数（这些函数体内无字符串花括号） */
function extractFn(src, name) {
  const start = src.indexOf('function ' + name + '(');
  assert.notEqual(start, -1, `未找到函数 ${name}`);
  let depth = 0;
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(`函数 ${name} 括号未闭合`);
}

function setupDom() {
  const dom = new JSDOM('<!doctype html><html><body></body></html>');
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  return dom.window.document;
}

const feedbackSrc = readScript('ui/assets/scripts/ui/feedback.js');

function buildCpaActions() {
  const src = readScript('ui/assets/scripts/65-extensions.js');
  const factory = new Function(
    'EXTENSION_TRANSIENT_STATUSES',
    'openExtensionDetail',
    'handleExtensionAction',
    `
    ${extractFn(feedbackSrc, 'spinnerHtml')}
    ${extractFn(feedbackSrc, 'loadingHtml')}
    ${extractFn(src, 'getCpaActionConfig')}
    ${extractFn(src, 'bindCpaActionButton')}
    ${extractFn(src, 'renderCpaActions')}
    return { renderCpaActions };
    `,
  );
  const transient = new Set([
    'checking',
    'installing',
    'starting',
    'stopping',
    'updating',
    'uninstalling',
  ]);
  return factory(transient, () => {}, () => {}).renderCpaActions;
}

const CPA_CARD_HTML = `
  <button id="extension-cpa-primary-action"></button>
  <div id="extension-cpa-secondary-actions"></div>`;

test('扩展中心 CPA 主按钮：每个加载态只有一个 spinner', () => {
  const doc = setupDom();
  const renderCpaActions = buildCpaActions();
  for (const status of ['checking', 'installing', 'starting', 'stopping', 'updating', 'uninstalling']) {
    doc.body.innerHTML = CPA_CARD_HTML;
    renderCpaActions(status, true, false);
    const primary = doc.getElementById('extension-cpa-primary-action');
    assert.equal(
      primary.querySelectorAll('.ab-spinner, .btn-spinner').length,
      1,
      `${status} 状态的主按钮出现了多个 spinner：${primary.innerHTML}`,
    );
  }
});

test('扩展中心 CPA 主按钮：空闲态不带 spinner', () => {
  const doc = setupDom();
  const renderCpaActions = buildCpaActions();
  doc.body.innerHTML = CPA_CARD_HTML;
  renderCpaActions('running', true, false);
  const primary = doc.getElementById('extension-cpa-primary-action');
  assert.equal(primary.querySelectorAll('.ab-spinner, .btn-spinner').length, 0);
});

test('切换配置 toast：左侧已有 spinner 时标题不再叠加第二个', () => {
  const doc = setupDom();
  const src = readScript('ui/assets/scripts/55-platforms.js');
  const factory = new Function(
    '_switchFlowState',
    '_switchProgressPlatform',
    `
    ${extractFn(feedbackSrc, 'spinnerHtml')}
    ${extractFn(feedbackSrc, 'loadingHtml')}
    ${extractFn(src, 'updateSwitchProgress')}
    return { updateSwitchProgress };
    `,
  );
  doc.body.innerHTML = `
    <div id="switch-progress-toast" class="switch-progress-toast">
      <div class="switch-progress-spinner"></div>
      <div class="switch-progress-content">
        <div class="switch-progress-title">正在切换配置…</div>
        <div class="switch-progress-message"></div>
      </div>
    </div>`;
  const api = factory(null, 'codex');
  api.updateSwitchProgress({ platform: 'codex', step: 'running', message: '正在写入配置' });
  assert.equal(
    doc.querySelectorAll('#switch-progress-toast .switch-progress-spinner, #switch-progress-toast .ab-spinner').length,
    1,
  );
});

test('全部 UI 脚本不得自造第二套 spinner 类名（btn-spinner）', () => {
  const offenders = [];
  const walk = (dir, depth) => {
    if (depth > 6) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (['node_modules', 'target', '.git', 'tmp'].includes(entry.name)) continue;
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(p, depth + 1);
      else if (entry.name.endsWith('.js') && fs.readFileSync(p, 'utf8').includes('btn-spinner')) {
        offenders.push(path.relative(root, p));
      }
    }
  };
  walk(path.join(root, 'ui/assets/scripts'), 0);
  assert.deepEqual(offenders, [], `发现自造 spinner：${offenders.join(', ')}`);
});
