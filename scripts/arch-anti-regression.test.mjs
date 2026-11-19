// 架构防退化测试：锁定零技术债重构的跨端核心不变量（Rust / Sidecar / UI / 结构体积）
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  runActionReachability,
  runArchAntiRegressionChecks,
  runCodebaseStructureChecks,
  runDynamicLoadingChecks,
} from './lib/key-features/ui-guards-and-presets.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function readRepo(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function runGuardCollector(guardFn, rootDir = ROOT) {
  const results = [];
  guardFn({
    root: rootDir,
    ok: (name, cond, detail = '') => results.push({ name, cond: Boolean(cond), detail }),
    warn: () => {},
  });
  return results;
}

test('UI 架构防退化：57-pb-models.js 与 00-bridge.js 已删除、provider-store.js 集中落盘、零 write_provider_store', () => {
  assert.equal(fs.existsSync(path.join(ROOT, 'ui/assets/scripts/57-pb-models.js')), false, '57-pb-models.js 不得复活');
  assert.equal(fs.existsSync(path.join(ROOT, 'ui/assets/scripts/00-bridge.js')), false, '00-bridge.js 不得复活');
  const mainJs = readRepo('ui/assets/scripts/main.js');
  assert.equal(mainJs.includes('57-pb-models'), false, 'main.js 不得再导入 57-pb-models.js');
  assert.equal(mainJs.includes('00-bridge'), false, 'main.js 不得引用 00-bridge.js');
  assert.equal(readRepo('ui/index.html').includes('00-bridge.js'), false, 'ui/index.html 不得加载 00-bridge.js');

  const logsIdx = mainJs.indexOf("import './state/logs.js';");
  const storeIdx = mainJs.indexOf("import './state/provider-store.js';");
  const actionsIdx = mainJs.indexOf("import './05-actions.js';");
  assert.ok(logsIdx >= 0 && storeIdx > logsIdx && actionsIdx > storeIdx,
    'state/provider-store.js 必须在 state/logs.js 之后、05-actions.js 之前导入');

  const providerStoreSrc = readRepo('ui/assets/scripts/state/provider-store.js');
  assert.match(providerStoreSrc, /export function resolveBoundProviderView\(/);
  assert.match(providerStoreSrc, /export async function persistProviders\(/);
  assert.match(providerStoreSrc, /export async function mutateProviderStore\(/);

  for (const rel of ['ui/assets/scripts', 'ui-src']) {
    const walk = (dir) => {
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        if (['node_modules', 'tmp'].includes(ent.name)) continue;
        const full = path.join(dir, ent.name);
        if (ent.isDirectory()) { walk(full); continue; }
        if (!/\.(js|html)$/i.test(ent.name)) continue;
        const content = fs.readFileSync(full, 'utf8');
        assert.equal(/\bwrite_provider_store\b/.test(content), false,
          `${path.relative(ROOT, full)} 不得调用不存在的 write_provider_store`);
      }
    };
    walk(path.join(ROOT, rel));
  }
});

test('UI 守卫门禁：KNOWN_MISSING 清零、动态/前缀动作 100% 可达、扩展 LOADING_WORDS 有效拦截', () => {
  const guardSrc = readRepo('scripts/lib/key-features/ui-guards-and-presets.mjs');
  assert.match(guardSrc, /const KNOWN_MISSING = new Set\(\s*\)/, 'KNOWN_MISSING 必须保持为空集合（0 项）');

  const actionResults = runGuardCollector(runActionReachability);
  for (const item of actionResults) {
    assert.equal(item.cond, true, `${item.name} 失败: ${item.detail}`);
  }

  const loadingResults = runGuardCollector(runDynamicLoadingChecks);
  for (const item of loadingResults) {
    assert.equal(item.cond, true, `${item.name} 失败: ${item.detail}`);
  }

  // 反向自证：验证扩充后的 LOADING_WORDS 词表能真正抓出「生成中...」「拉取中...」「测速中...」
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-loading-guard-'));
  try {
    fs.mkdirSync(path.join(tmpRoot, 'ui/assets/scripts/ui'), { recursive: true });
    fs.mkdirSync(path.join(tmpRoot, 'ui/assets/styles'), { recursive: true });
    fs.writeFileSync(path.join(tmpRoot, 'ui/assets/scripts/ui/feedback.js'),
      'function loadingHtml(){} g.loadingHtml = loadingHtml; g.setLoading = setLoading;', 'utf8');
    fs.writeFileSync(path.join(tmpRoot, 'ui/assets/styles/00-foundation.css'),
      '.ab-spinner {} @keyframes ab-spin {}', 'utf8');
    fs.writeFileSync(path.join(tmpRoot, 'ui/assets/scripts/sample.js'),
      'btn.textContent = "生成中..."; btn2.textContent = "拉取中..."; btn3.textContent = "测速中...";', 'utf8');

    const probe = runGuardCollector(runDynamicLoadingChecks, tmpRoot);
    const staticCheck = probe.find((r) => r.name.includes('无静态 loading 文案'));
    assert.ok(staticCheck && staticCheck.cond === false, '扩充后的 LOADING_WORDS 必须拦截静态生成/拉取/测速文案');
    assert.match(staticCheck.detail, /sample\.js:1/);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('Sidecar 架构防退化：5 个死模块与 inject-models.js 已删、不写 providers.json、标准 SSE/Codec 与 UTF-8 解码就绪', () => {
  for (const dead of [
    'sidecar/multimodal-middleware.js',
    'sidecar/handlers/web-search.js',
    'sidecar/handlers/completions.js',
    'sidecar/handlers/embeddings.js',
    'sidecar/retry.js',
    'sidecar/inject-models.js',
  ]) {
    assert.equal(fs.existsSync(path.join(ROOT, dead)), false, `死模块 ${dead} 必须保持删除状态`);
  }

  for (const required of [
    'sidecar/lib/sse-parser.js',
    'sidecar/lib/codec-registry.js',
    'sidecar/lib/upstream-decoder.js',
    'sidecar/lib/http-retry.js',
    'sidecar/lib/local-proxy/count-tokens.js',
  ]) {
    assert.equal(fs.existsSync(path.join(ROOT, required)), true, `新网关基础设施 ${required} 必须存在`);
  }

  // 验证 UTF-8 多字节截断修复不再退化为裸字符串直拼
  const cursorCommon = readRepo('sidecar/lib/cursor/common.js');
  assert.match(cursorCommon, /createSSEParser/);
  assert.equal(/buffer\s*\+=\s*chunk\.toString\(['"]utf8['"]\)/.test(cursorCommon), false);

  const pluginLoader = readRepo('sidecar/plugin-loader.js');
  assert.match(pluginLoader, /Buffer\.concat\(chunks\)\.toString\(['"]utf8['"]\)/);

  const stepExecutor = readRepo('sidecar/step-executor.js');
  assert.match(stepExecutor, /new StringDecoder\(['"]utf8['"]\)/);

  const poolSrc = readRepo('sidecar/provider-pool.js');
  assert.equal(/\bwriteFile(?:Sync)?\b|\bwriteJsonAtomic\b/.test(poolSrc), false,
    'provider-pool.js 严禁回写 providers.json');
});

test('Rust 架构防退化：store_io 锁事务存在、app.asar 非裸写、platforms 无 prelude 块、双门控默认开启', () => {
  const storeIo = readRepo('src-tauri/src/commands/store_io.rs');
  assert.match(storeIo, /pub\(crate\)\s+fn\s+write_atomic\(/);
  assert.match(storeIo, /pub\(crate\)\s+fn\s+with_file_lock</);
  assert.match(storeIo, /pub\(crate\)\s+fn\s+update_provider_store</);
  assert.match(storeIo, /pub\(crate\)\s+fn\s+update_proxy_routes</);

  const cmdsMod = readRepo('src-tauri/src/commands/mod.rs');
  assert.match(cmdsMod, /pub\s+mod\s+store_io;/);
  assert.match(cmdsMod, /pub\(crate\)\s+use\s+store_io::write_atomic;/);

  const agPatch = readRepo('src-tauri/src/commands/platforms/antigravity_patch.rs').split(/#\[cfg\(test\)\]/)[0];
  const hubPatch = readRepo('src-tauri/src/commands/antigravity_localization/hub_patch.rs').split(/#\[cfg\(test\)\]/)[0];
  assert.equal(/\bfs::write\s*\(/.test(agPatch), false, 'antigravity_patch.rs 不得裸 fs::write');
  assert.equal(/\bfs::write\s*\(/.test(hubPatch), false, 'hub_patch.rs 不得裸 fs::write');
  assert.match(agPatch, /write_atomic\(/);
  assert.match(hubPatch, /write_atomic\(/);

  const jsoncMod = readRepo('src-tauri/src/commands/jsonc_edit/mod.rs');
  assert.match(jsoncMod, /fn\s+format_preserving_enabled\(\)\s*->\s*bool\s*\{[\s\S]*?Err\(_\)\s*=>\s*true/);

  const agentStash = readRepo('src-tauri/src/commands/agent_stash.rs');
  assert.match(agentStash, /fn\s+field_restore_enabled\(\)\s*->\s*bool\s*\{[\s\S]*?Err\(_\)\s*=>\s*true/);
});

test('全仓结构、单源同步与净场防退化总守卫：含 cursor-core <=800 行、共享资源字节一致、scripts 净场', () => {
  const structResults = runGuardCollector(runCodebaseStructureChecks);
  for (const item of structResults) {
    assert.equal(item.cond, true, `${item.name} 失败: ${item.detail}`);
  }
  const lineCheck = structResults.find((r) => r.name.includes('全库代码文件行数均'));
  assert.ok(lineCheck && /已扫描\s+(\d+)\s+个文件/.test(lineCheck.name), '应统计扫描文件总数');
  const scannedCount = Number(lineCheck.name.match(/已扫描\s+(\d+)\s+个文件/)[1]);
  assert.ok(scannedCount >= 850, `应将 cursor-core 纳入扫描（当前仅 ${scannedCount} 个文件）`);

  const antiResults = runGuardCollector(runArchAntiRegressionChecks);
  assert.ok(antiResults.length >= 11, '应包含 11 项以上架构防退化检查');
  for (const item of antiResults) {
    assert.equal(item.cond, true, `${item.name} 失败: ${item.detail}`);
  }

  // 共享资源字节 100% 一致与单源约束
  assert.equal(fs.existsSync(path.join(ROOT, 'src-tauri/resources/model-context-presets.json')), false);
  assert.match(readRepo('src-tauri/src/commands/platforms/model_context.rs'), /ui\/assets\/model-context-presets\.json/);
  for (const [a, b] of [
    ['sidecar/windsurf-catalog.json', 'src-tauri/resources/sidecar/windsurf-catalog.json'],
    ['sidecar/prompts/system-prompt.md', 'src-tauri/resources/prompts/system-prompt.md'],
  ]) {
    assert.equal(Buffer.compare(fs.readFileSync(path.join(ROOT, a)), fs.readFileSync(path.join(ROOT, b))), 0,
      `${a} 与 ${b} 必须逐字节一致`);
  }

  // Cursor 4 个模式基础 prompt 字节一致防漂移
  const promptModes = ['agent', 'debug', 'plan', 'subagent'];
  const basePromptBuf = fs.readFileSync(path.join(ROOT, 'cursor-core/prompt/cursor/agent/prompt.md'));
  for (const mode of promptModes.slice(1)) {
    const buf = fs.readFileSync(path.join(ROOT, `cursor-core/prompt/cursor/${mode}/prompt.md`));
    assert.equal(Buffer.compare(basePromptBuf, buf), 0, `cursor-core/prompt/cursor/${mode}/prompt.md 发生漂移`);
  }

  // scripts/ 净场与自动扫描防退化
  assert.equal(fs.existsSync(path.join(ROOT, 'scripts/_wb_asar_extract')), false);
  assert.equal(fs.existsSync(path.join(ROOT, 'scripts/_review_diffs')), false);
  assert.equal(fs.existsSync(path.join(ROOT, 'icon-backups')), false);
  assert.equal(fs.existsSync(path.join(ROOT, 'ui/index.html.baseline')), false);
  const strayUnderscore = fs.readdirSync(path.join(ROOT, 'scripts')).filter((n) => n !== '__pycache__' && n.startsWith('_'));
  assert.deepEqual(strayUnderscore, [], `scripts/ 下不得残留 _* 探针: ${strayUnderscore.join(', ')}`);
  assert.equal(readRepo('scripts/build/build_protected_sidecar.py').includes('"inject-models.js"'), false);
});
