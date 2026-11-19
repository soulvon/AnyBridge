// 回归测试：
// 1. Rust / Sidecar 单元测试与门控严格隔离宿主机真实状态（禁止误清真实 Antigravity settings.json、覆盖 agent-stash.json、写真实 ag-handshake.log、强杀活进程）
// 2. Antigravity UI 刷新状态 / 刷新模型列表 / 切页必须触发后端实时探测（detect_platforms）并具备正确的动态加载态与错误反馈
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function readRepoFile(rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}

/** 带字符串/模板字面量/注释意识的花括号配平提取函数 */
function extractFn(src, name) {
  const re = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`);
  const m = re.exec(src);
  assert.ok(m, `未找到函数 ${name}`);
  const start = m.index;
  const openParen = src.indexOf('(', start);
  let parenDepth = 0;
  let closeParen = -1;
  for (let i = openParen; i < src.length; i++) {
    if (src[i] === '(') parenDepth++;
    else if (src[i] === ')') {
      parenDepth--;
      if (parenDepth === 0) {
        closeParen = i;
        break;
      }
    }
  }
  assert.notEqual(closeParen, -1, `函数 ${name} 参数括号未闭合`);
  const openBrace = src.indexOf('{', closeParen);
  assert.notEqual(openBrace, -1, `函数 ${name} 缺少函数体`);

  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  let inLineComment = false;
  let inBlockComment = false;
  let tmplStack = [];

  for (let i = openBrace; i < src.length; i++) {
    const ch = src[i];
    const next = src[i + 1];

    if (inLineComment) {
      if (ch === '\n') inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      if (ch === '*' && next === '/') {
        inBlockComment = false;
        i++;
      }
      continue;
    }
    if (inSingle) {
      if (ch === '\\') { i++; continue; }
      if (ch === "'") inSingle = false;
      continue;
    }
    if (inDouble) {
      if (ch === '\\') { i++; continue; }
      if (ch === '"') inDouble = false;
      continue;
    }
    const inTmpl = tmplStack.length > 0 && tmplStack[tmplStack.length - 1].mode === 'text';
    if (inTmpl) {
      if (ch === '\\') { i++; continue; }
      if (ch === '`') {
        tmplStack.pop();
        continue;
      }
      if (ch === '$' && next === '{') {
        tmplStack.push({ mode: 'expr', depth: 1 });
        i++;
      }
      continue;
    }

    if (ch === '/' && next === '/') { inLineComment = true; i++; continue; }
    if (ch === '/' && next === '*') { inBlockComment = true; i++; continue; }
    if (ch === "'") { inSingle = true; continue; }
    if (ch === '"') { inDouble = true; continue; }
    if (ch === '`') { tmplStack.push({ mode: 'text' }); continue; }

    if (ch === '{') {
      if (tmplStack.length > 0 && tmplStack[tmplStack.length - 1].mode === 'expr') {
        tmplStack[tmplStack.length - 1].depth++;
      }
      depth++;
    } else if (ch === '}') {
      if (tmplStack.length > 0 && tmplStack[tmplStack.length - 1].mode === 'expr') {
        const top = tmplStack[tmplStack.length - 1];
        top.depth--;
        if (top.depth === 0) {
          tmplStack.pop();
          continue;
        }
      }
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(`函数 ${name} 括号未闭合`);
}

function setupAntigravityDom() {
  const partialHtml = readRepoFile('ui-src/partials/pages/platform-antigravity.html');
  const dom = new JSDOM(`<!doctype html><html><body>${partialHtml}</body></html>`);
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.globalThis._currentAntigravityTarget = 'antigravity';
  // 加载真实 i18n 目录验证新 key 在 zh-CN 与 en-US 双语均有完整配置
  const zhSrc = readRepoFile('ui/assets/i18n/zh-CN.js');
  const zhFn = new Function('window', zhSrc);
  zhFn(dom.window);
  const zhDict = dom.window.ByokI18nCatalog?.['zh-CN']?.translations || {};
  dom.window.t = (k) => zhDict[k] ?? k;
  return dom;
}

function readAllPlatformScripts() {
  const dir = path.join(root, 'ui/assets/scripts/platforms');
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.js'))
    .sort()
    .map((f) => fs.readFileSync(path.join(dir, f), 'utf8'))
    .join('\n');
}

function buildAntigravityHarness({ initialInfos, onDetectPlatforms, onLoadProviders }) {
  const feedbackSrc = readRepoFile('ui/assets/scripts/ui/feedback.js');
  const platSrc = readAllPlatformScripts();

  const toasts = [];
  const logs = [];
  const invokeCalls = [];

  const harness = {
    platformInfos: initialInfos,
    providerStore: { antigravityMode: 'pure', antigravityConfigs: [] },
    _antigravitySelectedSet: new Set(),
    PLATFORM_UI_COPY: {
      antigravity: { configHint: 'Antigravity/User/settings.json' },
      'antigravity-ide': { configHint: 'Antigravity IDE/User/settings.json' },
    },
    _agentRegistryCache: { at: 0, list: [] },
    invoke: async (cmd, args = {}) => {
      invokeCalls.push({ cmd, args });
      if (cmd === 'detect_platforms') return onDetectPlatforms(args);
      return null;
    },
    loadProviders: async () => {
      if (onLoadProviders) return onLoadProviders();
    },
    showBottomToast: (msg, type) => toasts.push({ msg, type }),
    addLog: (level, msg) => logs.push({ level, msg }),
    navigateTo: () => {},
    renderPlatformCards: () => {},
    renderPlatformProviderOptions: () => {},
    renderHeroVersion: () => {},
    ensureRegistryRailItems: async () => {},
    setPlatformRailActive: () => {},
    antigravityRenderTableRows: () => {},
    antigravityUpdateBulkActionButtons: () => {},
    refreshAntigravityLangStatus: async () => {},
    isRevealablePath: () => false,
    bindRevealPathLabel: () => {},
    platformEsc: (s) => String(s ?? ''),
    renderCodexPageStatus: () => {},
    renderClaudeCodePageStatus: () => {},
    renderOpenCodePageStatus: () => {},
    renderGrokPageStatus: () => {},
  };

  // 使用同一份 UI 实现代码真实编译执行
  const factory = new Function(
    'ctx',
    `
    let platformInfos = ctx.platformInfos;
    let providerStore = ctx.providerStore;
    let _antigravitySelectedSet = ctx._antigravitySelectedSet;
    const PLATFORM_UI_COPY = ctx.PLATFORM_UI_COPY;
    const _agentRegistryCache = ctx._agentRegistryCache;
    const invoke = ctx.invoke;
    const loadProviders = ctx.loadProviders;
    const showBottomToast = ctx.showBottomToast;
    const addLog = ctx.addLog;
    const navigateTo = ctx.navigateTo;
    const renderPlatformCards = ctx.renderPlatformCards;
    const renderPlatformProviderOptions = ctx.renderPlatformProviderOptions;
    const renderHeroVersion = ctx.renderHeroVersion;
    const ensureRegistryRailItems = ctx.ensureRegistryRailItems;
    const setPlatformRailActive = ctx.setPlatformRailActive;
    const antigravityRenderTableRows = ctx.antigravityRenderTableRows;
    const antigravityUpdateBulkActionButtons = ctx.antigravityUpdateBulkActionButtons;
    const refreshAntigravityLangStatus = ctx.refreshAntigravityLangStatus;
    const bindRevealPathLabel = ctx.bindRevealPathLabel;
    const platformEsc = ctx.platformEsc;
    const renderCodexPageStatus = ctx.renderCodexPageStatus;
    const renderClaudeCodePageStatus = ctx.renderClaudeCodePageStatus;
    const renderOpenCodePageStatus = ctx.renderOpenCodePageStatus;
    const renderGrokPageStatus = ctx.renderGrokPageStatus;

    ${extractFn(feedbackSrc, 'spinnerHtml')}
    ${extractFn(feedbackSrc, 'loadingHtml')}
    ${extractFn(feedbackSrc, 'setLoading')}
    ${extractFn(feedbackSrc, 'clearLoading')}
    ${extractFn(platSrc, 'platformInfoOf')}
    ${extractFn(platSrc, 'platformMetaIds')}
    ${extractFn(platSrc, 'platformDef')}
    ${extractFn(platSrc, 'platformFormatLabel')}
    ${extractFn(platSrc, 'refreshPlatforms')}
    ${extractFn(platSrc, 'renderPlatformDetailStatuses')}
    ${extractFn(platSrc, 'getAntigravityTarget')}
    ${extractFn(platSrc, 'renderAntigravityPageStatus')}
    ${extractFn(platSrc, 'antigravityPageRoot')}
    ${extractFn(platSrc, 'getAntigravityCurrentMode')}
    ${extractFn(platSrc, 'syncAntigravityModeUi')}
    ${extractFn(platSrc, 'antigravityRefreshConsole')}
    ${platSrc.includes('function antigravityRefreshConsoleAction(') ? extractFn(platSrc, 'antigravityRefreshConsoleAction') : ''}
    ${extractFn(platSrc, 'openPlatformPage')}

    return {
      antigravityRefreshConsole,
      antigravityRefreshConsoleAction: typeof antigravityRefreshConsoleAction === 'function' ? antigravityRefreshConsoleAction : null,
      openPlatformPage,
      refreshPlatforms,
      platformDef,
      platformFormatLabel,
    };
    `,
  );

  const api = factory(harness);
  return { api, toasts, logs, invokeCalls };
}

function readPlatformsRustTree(includeTests) {
  const baseDir = path.join(root, 'src-tauri/src/commands/platforms');
  const out = [];
  const walk = (d) => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, ent.name);
      if (ent.isDirectory()) {
        if (includeTests ? true : ent.name !== 'tests') walk(p);
      } else if (ent.name.endsWith('.rs')) {
        if (includeTests && !p.includes(`${path.sep}tests${path.sep}`)) continue;
        out.push(fs.readFileSync(p, 'utf8'));
      }
    }
  };
  walk(baseDir);
  return out.join('\n');
}

function nextRustFnOffset(text, fromIndex) {
  const m = text.slice(fromIndex).search(/\n(?:    )?(?:pub(?:\([^)]*\))?\s+)?fn /);
  return m >= 0 ? fromIndex + m : text.length;
}

test('Rust 测试严格隔离宿主机真实 stash、settings.json、安装目录与存活进程', () => {
  const rs = readPlatformsRustTree(false);
  const testsBody = readPlatformsRustTree(true);

  // 1. 测试块不得调用任何无 stash 参数或直碰真实配置/stash 目录的入口
  const forbiddenTestCalls = [
    'agent_stash_dir()',
    '.apply_claude(',
    'apply_claude_config_file(',
    '.apply_codex(',
    '.apply_codex_official(',
    '.apply_grok(',
    '.apply_grok_official(',
    '.apply_opencode_official(',
    'write_pi_managed_models(',
    'write_hermes_managed_models(',
    'write_harness_managed_models(',
    'apply_buddy_models_json(',
    'apply_opencode_config_file(',
    '.apply_zcode(',
    '.apply_antigravity(',
    '.apply_antigravity_official(',
    '.apply_antigravity_ide(',
    '.apply_antigravity_ide_official(',
    'clear_antigravity_stale_managed_endpoints()',
  ];
  const violations = forbiddenTestCalls.filter((needle) => testsBody.includes(needle));
  assert.deepEqual(
    violations,
    [],
    `platforms 测试代码仍包含未隔离宿主环境的调用: ${violations.join(', ')}`,
  );

  // 2. 宿主机全局副作用入口必须具备 #[cfg(test)] fail-fast 拦截（防未来误调再次写坏真机）
  for (const fnSig of [
    'fn agent_stash_dir()',
    'fn clear_antigravity_stale_managed_endpoints()',
    'fn kill_antigravity_language_server()',
    'pub(crate) fn patch_antigravity_ide_extension()',
  ]) {
    const start = rs.indexOf(fnSig);
    assert.ok(start >= 0, `未找到函数 ${fnSig}`);
    const head = rs.slice(start, start + 500);
    assert.ok(
      head.includes('#[cfg(test)]'),
      `${fnSig} 必须包含 #[cfg(test)] 阻断守卫，防止未来单测再次污染宿主机/杀进程`,
    );
  }

  // 3. apply_antigravity*_with_stash 的宿主机全局副作用必须在 !cfg!(test) 守卫下
  for (const fnSig of [
    'fn apply_antigravity_ide_with_stash(',
    'fn apply_antigravity_with_stash(',
    'fn apply_antigravity_ide_official_with_stash(',
    'fn apply_antigravity_official_with_stash(',
  ]) {
    const start = rs.indexOf(fnSig);
    assert.ok(start >= 0, `未找到函数 ${fnSig}`);
    const end = nextRustFnOffset(rs, start + fnSig.length);
    const body = rs.slice(start, end);
    assert.ok(
      body.includes('!cfg!(test)'),
      `${fnSig} 必须用 !cfg!(test) 隔离宿主机全局副作用（asar/extension 补丁、reg、跨端清理、kill 进程）`,
    );
  }

  // 4. 运行注入块 Node 脚本的测试必须同时隔离 USERPROFILE / HOME（否则 APPDATA 为空时会穿透到真实用户目录）
  assert.ok(
    testsBody.includes('fn isolated_node_cmd('),
    'platforms 测试需提供 isolated_node_cmd 隔离 USERPROFILE/HOME/APPDATA/XDG_*',
  );
  for (const fnSig of [
    'fn assert_ls_defaults_runtime_switches(',
    'fn antigravity_restore_clears_inherited_endpoint(',
    'fn antigravity_injection_actually_works_at_runtime(',
    'fn antigravity_injection_reads_jsonc_settings_default_path(',
  ]) {
    const start = testsBody.indexOf(fnSig);
    assert.ok(start >= 0, `未找到 ${fnSig}`);
    const end = nextRustFnOffset(testsBody, start + fnSig.length);
    const body = testsBody.slice(start, end);
    assert.ok(
      body.includes('isolated_node_cmd(') && body.includes('process.env.USERPROFILE'),
      `${fnSig} 必须同时隔离 Node 子进程与 JS 内的 USERPROFILE/HOME，禁止穿透到宿主机真 settings.json`,
    );
  }
});

test('Sidecar antigravity.test.js 运行时不向宿主机真实配置目录写 ag-handshake.log', () => {
  // 通过隔离 APPDATA/XDG_CONFIG_HOME/HOME 验证 sidecar 测试是否仍向“真实默认配置目录”泄露日志
  const fakeAppData = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-sidecar-leak-probe-'));
  const fakeAnyBridgeDir = path.join(fakeAppData, 'anybridge');
  fs.mkdirSync(fakeAnyBridgeDir, { recursive: true });
  const env = { ...process.env };
  delete env.BYOK_CONFIG_DIR;
  delete env.ANYBRIDGE_CONFIG_DIR;
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_CHANNEL_FD;
  env.APPDATA = fakeAppData;
  env.XDG_CONFIG_HOME = fakeAppData;
  env.HOME = fakeAppData;

  try {
    // 显式指定 --test-reporter=tap：Node 默认在本地 TTY 用 spec（ℹ pass N），
    // 在 CI 非 TTY 管道下用 TAP（# pass N），不固定 reporter 会导致本地绿、CI 红。
    const res = spawnSync(process.execPath, ['--test', '--test-reporter=tap', 'sidecar/antigravity.test.js'], {
      cwd: root,
      env,
      encoding: 'utf8',
    });
    assert.equal(res.status, 0, `sidecar/antigravity.test.js 执行失败:\n${res.stdout}\n${res.stderr}`);
    assert.match(res.stdout, /# tests 12\b/, 'sidecar/antigravity.test.js 应完整执行全部 12 项用例');
    assert.match(res.stdout, /# pass 12\b/, 'sidecar/antigravity.test.js 全部 12 项用例应通过');
    assert.match(res.stdout, /# fail 0\b/, 'sidecar/antigravity.test.js 失败项应为 0');

    const leakedLog = path.join(fakeAnyBridgeDir, 'ag-handshake.log');
    assert.equal(
      fs.existsSync(leakedLog),
      false,
      `sidecar/antigravity.test.js 未隔离 BYOK_CONFIG_DIR，直接向默认配置目录写入了 ag-handshake.log: ${leakedLog}`,
    );
  } finally {
    fs.rmSync(fakeAppData, { recursive: true, force: true });
  }
});

test('Antigravity UI 刷新状态按钮必须强制重扫后端、带动态 spinner，并及时纠正假「已接入」状态', async () => {
  setupAntigravityDom();
  const refreshBtn = document.getElementById('antigravityRefreshBtn');
  assert.ok(refreshBtn, '缺少 #antigravityRefreshBtn');
  const partialHtml = readRepoFile('ui-src/partials/pages/platform-antigravity.html');
  assert.ok(
    partialHtml.includes('data-action="antigravityRefreshConsoleAction"'),
    'platform-antigravity.html 的刷新按钮应绑定实时探测动作 antigravityRefreshConsoleAction（而非仅重绘内存缓存）',
  );

  let loadProvidersCalled = 0;
  let spinnerSeenDuringCall = false;
  let disabledSeenDuringCall = false;

  const { api, toasts } = buildAntigravityHarness({
    initialInfos: [
      { id: 'antigravity', installed: true, managedByAnyBridge: true, configPath: 'C:/fake/Antigravity/User/settings.json' },
      { id: 'antigravity-ide', installed: true, managedByAnyBridge: true, configPath: 'C:/fake/Antigravity IDE/User/settings.json' },
    ],
    onLoadProviders: async () => { loadProvidersCalled++; },
    onDetectPlatforms: async (args) => {
      assert.equal(args.force, true, '手动点刷新状态必须传 force: true 绕过缓存');
      disabledSeenDuringCall = refreshBtn.disabled === true;
      spinnerSeenDuringCall = refreshBtn.querySelectorAll('.ab-spinner').length === 1;
      // 模拟外部已把 settings.json 清空 → 真实状态为未接入
      return [
        { id: 'antigravity', installed: true, managedByAnyBridge: false, configPath: 'C:/fake/Antigravity/User/settings.json' },
        { id: 'antigravity-ide', installed: true, managedByAnyBridge: false, configPath: 'C:/fake/Antigravity IDE/User/settings.json' },
      ];
    },
  });

  // 先渲染为旧的“已接入”缓存态
  await api.antigravityRefreshConsole({ silent: true });
  assert.equal(document.getElementById('antigravity-main-btn-text').textContent, '已接入');
  assert.equal(document.getElementById('antigravityRestoreBtn').disabled, false);

  assert.ok(api.antigravityRefreshConsoleAction, '55-platforms.js 必须实现 antigravityRefreshConsoleAction');
  await api.antigravityRefreshConsoleAction(refreshBtn);

  assert.equal(loadProvidersCalled >= 1, true, '点击刷新应同时重读 providers.json 模型列表');
  assert.equal(disabledSeenDuringCall, true, '探测期间刷新按钮应禁用防连点');
  assert.equal(spinnerSeenDuringCall, true, '探测期间刷新按钮应显示单个 .ab-spinner');
  assert.equal(refreshBtn.disabled, false, '探测完成后刷新按钮必须恢复可点击');
  assert.equal(refreshBtn.textContent.trim(), '刷新状态', '探测完成后刷新按钮文字必须完整恢复');
  assert.equal(refreshBtn.querySelectorAll('.ab-spinner').length, 0, '完成后不应残留 spinner');

  assert.equal(
    document.getElementById('antigravity-main-btn-text').textContent,
    '一键接入',
    '真实配置已退回官方时，刷新后必须把假「已接入」纠正为「一键接入」',
  );
  assert.equal(document.getElementById('antigravityRestoreBtn').disabled, true, '未接入时「停止接入」必须禁用');
  assert.ok(toasts.some(t => t.type === 'success'), '手动刷新成功后应有轻提示反馈');
});

test('Antigravity UI 模型刷新图标按钮触发探测时只换单圈 spinner 且完整恢复原 SVG，失败时清晰报错', async () => {
  setupAntigravityDom();
  const iconBtn = document.querySelector('.platform-model-btn-icon[aria-label="刷新模型列表"]');
  assert.ok(iconBtn, '缺少刷新模型列表图标按钮');
  const origSvgHtml = iconBtn.innerHTML;

  let spinnerCountDuringCall = 0;
  let shouldFail = false;

  const { api, toasts } = buildAntigravityHarness({
    initialInfos: [
      { id: 'antigravity', installed: true, managedByAnyBridge: true, configPath: 'C:/fake/settings.json' },
    ],
    onDetectPlatforms: async () => {
      spinnerCountDuringCall = iconBtn.querySelectorAll('.ab-spinner').length;
      if (shouldFail) throw new Error('模拟探测超时');
      return [{ id: 'antigravity', installed: true, managedByAnyBridge: true, configPath: 'C:/fake/settings.json' }];
    },
  });

  assert.ok(api.antigravityRefreshConsoleAction, '缺少 antigravityRefreshConsoleAction');
  await api.antigravityRefreshConsoleAction(iconBtn);

  assert.equal(spinnerCountDuringCall, 1, '图标按钮加载态只能有 1 个 .ab-spinner，且不撑宽文字');
  assert.equal(iconBtn.disabled, false, '图标按钮完成后应恢复可点击');
  assert.equal(iconBtn.innerHTML, origSvgHtml, '图标按钮完成后必须完整还原原 SVG');

  // 失败分支：必须恢复按钮并弹出明确错误 toast，不静默吞错
  shouldFail = true;
  await api.antigravityRefreshConsoleAction(iconBtn);
  assert.equal(iconBtn.disabled, false, '报错后图标按钮必须恢复可点击');
  assert.equal(iconBtn.innerHTML, origSvgHtml, '报错后图标按钮必须还原原 SVG');
  assert.ok(
    toasts.some(t => t.type === 'error' && t.msg.includes('模拟探测超时')),
    '后端报错时必须向用户提示错误而非静默失败',
  );
});

test('Antigravity UI 切换到反重力或 Antigravity IDE 页时，即使缓存为已接入也会后台重测并纠偏', async () => {
  setupAntigravityDom();
  let detectCalled = 0;

  const { api } = buildAntigravityHarness({
    initialInfos: [
      { id: 'antigravity', installed: true, managedByAnyBridge: true, configPath: 'C:/fake/hub/settings.json' },
      { id: 'antigravity-ide', installed: true, managedByAnyBridge: true, configPath: 'C:/fake/ide/settings.json' },
    ],
    onDetectPlatforms: async () => {
      detectCalled++;
      return [
        { id: 'antigravity', installed: true, managedByAnyBridge: false, configPath: 'C:/fake/hub/settings.json' },
        { id: 'antigravity-ide', installed: true, managedByAnyBridge: false, configPath: 'C:/fake/ide/settings.json' },
      ];
    },
  });

  api.openPlatformPage('antigravity-ide');
  // 让异步后台探测微任务跑完
  await new Promise(r => setTimeout(r, 20));

  assert.equal(detectCalled >= 1, true, '切入 Antigravity/IDE 页面必须触发 detect_platforms 校对真实状态');
  assert.equal(
    document.getElementById('antigravity-main-btn-text').textContent,
    '一键接入',
    '异步校对完成后必须刷新掉启动时缓存的假「已接入」状态',
  );
});

test('平台元数据由后端 agent_spec 驱动且 Antigravity / IDE 协议标注为 Gemini', () => {
  const coreSrc = readRepoFile('ui/assets/scripts/platforms/core.js');
  assert.equal(/\bPLATFORM_DEFS\b/.test(coreSrc), false, 'core.js 不得再硬编码重复的 PLATFORM_DEFS');

  setupAntigravityDom();
  const { api } = buildAntigravityHarness({
    initialInfos: [
      { id: 'antigravity', displayName: 'Antigravity', vendor: 'Google', requiredApiFormat: 'gemini', installed: true },
      { id: 'antigravity-ide', displayName: 'Antigravity IDE', vendor: 'Google', requiredApiFormat: 'gemini', installed: true },
    ],
  });
  assert.equal(api.platformDef('antigravity').requiredApiFormat, 'gemini');
  assert.equal(api.platformDef('antigravity-ide').requiredApiFormat, 'gemini');
  assert.equal(api.platformFormatLabel(api.platformDef('antigravity').requiredApiFormat), 'Gemini');
  assert.equal(api.platformFormatLabel('openai'), 'OpenAI');
  assert.equal(api.platformFormatLabel('anthropic'), 'Anthropic');
});

test('resolveAntigravityConfigView 在主供应商 apiFormat 留空自动识别时，不得被老快照 cfg.apiFormat=openai 掩盖', () => {
  const agModelsSrc = readRepoFile('ui/assets/scripts/platforms/antigravity_models.js');
  const factory = new Function(
    'providerStore',
    `
    ${extractFn(agModelsSrc, 'isOfficialGoogleGeminiOnlyEndpointForUi')}
    ${extractFn(agModelsSrc, 'inferProviderApiFormat')}
    ${extractFn(agModelsSrc, 'resolveAntigravityConfigView')}
    return { resolveAntigravityConfigView };
    `,
  );
  const { resolveAntigravityConfigView } = factory({
    providers: [
      {
        id: 'p-relay',
        name: 'Relay Gemini',
        apiHost: 'https://relay.example.com',
        apiPath: '/v1beta/models/gemini-2.5-pro:generateContent',
        apiKey: 'AIza-relay',
        apiFormat: '',
      },
    ],
  });
  const view = resolveAntigravityConfigView({
    id: 'ag-old',
    name: 'gemini-2.5-pro',
    defaultModel: 'gemini-2.5-pro',
    sourceProviderId: 'p-relay',
    apiFormat: 'openai',
  });
  assert.equal(view.apiFormat, 'gemini', '关联主供应商且 apiFormat 留空自动识别时，应优先依据主供应商端点推断而非采用老快照 openai');
});

test('冷启动加载：init 在平台卡片渲染前预加载 agent registry，且不延迟 900ms 才初始化', async () => {
  const initSrc = readRepoFile('ui/assets/scripts/90-init.js');
  const heroSrc = readRepoFile('ui/assets/scripts/platforms/hero_and_agents.js');
  const loadRegIdx = initSrc.indexOf('loadAgentRegistry');
  const refreshIdx = initSrc.indexOf('refreshPlatforms(');
  assert.ok(loadRegIdx > 0 && refreshIdx > loadRegIdx, '90-init.js 必须在 refreshPlatforms 渲染前预加载 loadAgentRegistry');
  assert.equal(/setTimeout\([\s\S]*ensureRegistryRailItems[\s\S]*900/.test(heroSrc), false, '不得将 registry 初始化硬拖延 900ms 导致冷启动期间 platformDef 回退为 openai');

  setupAntigravityDom();
  const { api } = buildAntigravityHarness({
    initialInfos: [],
  });
  // 模拟 init 预先注入了 agent_registry 缓存，即使 detect_platforms 尚未返回
  const platSrc = readAllPlatformScripts();
  const probe = new Function(
    'registryList',
    `
    const platformInfos = [];
    const _agentRegistryCache = { at: Date.now(), list: registryList };
    const PLATFORM_UI_COPY = {};
    ${extractFn(platSrc, 'platformInfoOf')}
    ${extractFn(platSrc, 'platformDef')}
    return platformDef('antigravity');
    `,
  )([{ id: 'antigravity', name: 'Antigravity', vendor: 'Google', api_format: 'gemini', config_path: '~/.antigravity' }]);
  assert.equal(probe.requiredApiFormat, 'gemini');
});

test('Antigravity 拖拽导入含 sourceProviderId 的 JSON 时，不写入污染性的静态 apiFormat=openai 快照', () => {
  const factorySrc = readRepoFile('ui/assets/scripts/platforms/models_table_factory.js');
  assert.equal(
    /apiFormat:\s*inferProviderApiFormat\(m,\s*m\.defaultModel\s*\|\|\s*m\.model\s*\|\|\s*m\.id,\s*'openai'\)/.test(factorySrc),
    false,
    'models_table_factory.js 导入 antigravityConfigs 时不得对带 sourceProviderId 的条目强制写入静态 apiFormat 快照',
  );
});
