#!/usr/bin/env node
/**
 * 关键功能回归检查 —— 每次修改后必须运行；有失败则任务不得结束。
 *
 *   node scripts/check-key-features.mjs
 *
 * 背景：本轮连续出现「修复 A 路径漏了对称的 B 路径」「上次修的下次又坏」
 * 的回归，因此把出过事故的关键点固化成机器可验证的检查项：
 *
 *   [代码]  Rust 编译零错误 + 全量单测 + UI 脚本语法
 *   [判据]  workbench 结构完整性判定 / 语言包三条件判定 / CSP nonce 注入
 *   [环境]  本机已启用汉化的客户端：workbench 块、语言包链路、BYOK 一致性
 *
 * 退出码：0 = 全部通过；1 = 有失败（必须修复后重跑）。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failed = 0;
let passed = 0;

function ok(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`); }
}
function section(name) { console.log(`\n■ ${name}`); }

// ─────────────────────────────────────────────────────────────
// [1] Rust 编译与单测
// ─────────────────────────────────────────────────────────────
section('Rust 编译与单测');
try {
  execSync('cargo check --message-format short', { cwd: path.join(root, 'src-tauri'), stdio: 'pipe' });
  ok('cargo check 零错误', true);
} catch (e) {
  ok('cargo check 零错误', false, (e.stderr || e.message || '').slice(0, 300));
}
try {
  const out = execSync('cargo test --lib', { cwd: path.join(root, 'src-tauri'), stdio: 'pipe', encoding: 'utf8' });
  ok('cargo test 全量单测通过', /test result: ok/.test(out));
} catch (e) {
  ok('cargo test 全量单测通过', false, (e.stdout || e.message || '').slice(-300));
}

// ─────────────────────────────────────────────────────────────
// [2] UI 脚本语法（运行时动态加载，build:ui 不校验它们）
// ─────────────────────────────────────────────────────────────
section('UI 脚本语法');
const scriptsDir = path.join(root, 'ui', 'assets', 'scripts');
for (const f of fs.readdirSync(scriptsDir).filter(f => f.endsWith('.js'))) {
  try {
    execSync(`node --check "${path.join(scriptsDir, f)}"`, { stdio: 'pipe' });
    ok(f, true);
  } catch (e) {
    ok(f, false, (e.stderr || '').slice(0, 200));
  }
}

// ─────────────────────────────────────────────────────────────
// [3] 关键判据回归（出过事故的点，源码级断言）
// ─────────────────────────────────────────────────────────────
section('关键判据（源码级回归断言）');

// 3.1 workbench 损坏判据必须是结构完整性（不能用体积阈值——Devin 原厂仅 1.7KB）
{
  const s = fs.readFileSync(path.join(root, 'src-tauri/src/commands/app_localization.rs'), 'utf8');
  ok('损坏判据用 is_valid_workbench（结构）而非体积阈值', s.includes('fn is_valid_workbench') && !/MIN_VALID_WORKBENCH_LEN:\s*usize\s*=\s*\d{3,}/.test(s));
  ok('apply 前快照 + 写后校验存在', s.includes('html_snapshot_path') && s.includes('写后校验'));
  ok('语言包三条件判定（目录+废弃标记+注册表）', s.includes('条件 2：不在 .obsolete') && s.includes('条件 3：languagepacks.json'));
  ok('Windsurf/Devin 注入带 CSP nonce', s.includes('extract_csp_nonce') && s.includes('nonce='));
  ok('keeper 不重入死锁（apply_inner）', s.includes('fn apply_inner') && s.includes('apply_inner(platform'));
}

// 3.2 BYOK 剥离保留汉化块（strip_byok_block 单测锁过，这里查源码仍存在）
{
  const s = fs.readFileSync(path.join(root, 'src-tauri/src/commands/workbench_inject.rs'), 'utf8');
  ok('BYOK 剥离保留汉化块的测试仍在', s.includes('汉化块必须保留'));
  ok('BYOK 还原是剥离式而非整体覆盖', s.includes('fn strip_byok_block'));
}

// 3.3 Antigravity asar 补丁的幂等优化仍在
{
  const s = fs.readFileSync(path.join(root, 'src-tauri/src/commands/platforms.rs'), 'utf8');
  ok('BYOK asar 补丁轻量预检（幂等跳过）', s.includes('轻量预检'));
  ok('汉化 asar 补丁构造→比对→按需写回', fs.readFileSync(path.join(root, 'src-tauri/src/commands/antigravity_localization.rs'), 'utf8').includes('if original_code == new_code'));
}

// ─────────────────────────────────────────────────────────────
// [4] 本机环境实况（已启用汉化的客户端必须链路完整）
// ─────────────────────────────────────────────────────────────
section('本机环境（已启用汉化的客户端）');
const home = os.homedir();
const PACK_ID = 'ms-ceintl.vscode-language-pack-zh-hans';

function engineVersion(installRoot) {
  try {
    const pj = JSON.parse(fs.readFileSync(path.join(installRoot, 'resources', 'app', 'product.json'), 'utf8'));
    return pj.vscodeVersion || pj.version || null;
  } catch { return null; }
}

function checkClient(name, cfg) {
  const { installRoot, dotDir, appDataDir } = cfg;
  if (!fs.existsSync(installRoot)) { console.log(`  ⏭ ${name} 未安装，跳过`); return; }

  const wbCandidates = [
    path.join(installRoot, 'resources', 'app', 'out', 'vs', 'code', 'electron-browser', 'workbench', 'workbench.html'),
    path.join(installRoot, 'resources', 'app', 'out', 'vs', 'code', 'electron-sandbox', 'workbench', 'workbench.html'),
  ];
  const wbPath = wbCandidates.find(p => fs.existsSync(p));
  if (!wbPath) { ok(`${name} workbench.html 可定位`, false, '未找到'); return; }

  const html = fs.readFileSync(wbPath, 'utf8');
  const enabledPath = path.join(process.env.APPDATA || '', 'AnyBridge', 'localization', name.toLowerCase(), 'enabled.json');
  const enabled = fs.existsSync(enabledPath);

  // 结构完整性（无论是否汉化都必须满足）
  ok(`${name} workbench 结构完整（</body>）`, html.includes('</body>'));

  if (!enabled) { console.log(`  ⏭ ${name} 未启用汉化，跳过链路检查`); return; }

  // 已启用 → 汉化块必须在（keeper 保活的前提）
  ok(`${name} 已启用汉化 → workbench 含汉化块`, html.includes('<!-- anybridge-hans-start -->'));
  ok(`${name} 注入块带 CSP nonce（如原厂 CSP 有 nonce）`, !/nonce-[0-9a-f]+/.test(html) || html.includes('<script nonce='));

  // 语言包三条件
  const extDir = path.join(home, `.${name.toLowerCase()}`, 'extensions');
  const ver = engineVersion(installRoot);
  if (!ver) { ok(`${name} 引擎版本可读`, false); return; }
  const want = ver.split('.').slice(0, 2).join('.');

  const packDir = fs.existsSync(extDir)
    ? fs.readdirSync(extDir).find(d => {
        if (!d.startsWith(PACK_ID)) return false;
        // 目录名形如 `ms-ceintl...-1.126.0`：去掉前导 `-` 再解析版本
        const verStr = d.slice(PACK_ID.length).replace(/^-/, '');
        const parts = verStr.split('.').filter(x => /^\d+$/.test(x)).slice(0, 2).join('.');
        return parts === want;
      })
    : null;
  ok(`${name} 官方语言包目录存在且版本匹配（${want}.x）`, !!packDir, packDir ? '' : `extensions 下无 ${PACK_ID}@${want}.x`);

  if (packDir) {
    const obsPath = path.join(extDir, '.obsolete');
    let obsolete = false;
    if (fs.existsSync(obsPath)) {
      try {
        const m = JSON.parse(fs.readFileSync(obsPath, 'utf8'));
        obsolete = Object.keys(m).some(k => k.startsWith(packDir));
      } catch {}
    }
    ok(`${name} 语言包未被 .obsolete 标记`, !obsolete);

    const lpPath = path.join(process.env.APPDATA || '', appDataDir, 'languagepacks.json');
    let registered = false;
    try {
      const lp = JSON.parse(fs.readFileSync(lpPath, 'utf8'));
      registered = (lp['zh-cn']?.extensions || []).some(e =>
        e.extensionIdentifier?.id?.toLowerCase() === PACK_ID);
    } catch {}
    ok(`${name} languagepacks.json 已注册官方包`, registered);

    const argvPath = path.join(process.env.APPDATA || '', appDataDir, 'argv.json');
    let localeOk = false;
    try {
      // argv.json 是 JSONC（VS Code 模板带 // 注释），与 Rust 侧 parse_jsonc 对齐
      const raw = fs.readFileSync(argvPath, 'utf8');
      const jsonish = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      localeOk = JSON.parse(jsonish).locale === 'zh-cn';
    } catch {}
    ok(`${name} argv.json locale=zh-cn`, localeOk);
  }
}

checkClient('Windsurf', {
  installRoot: 'E:/Program/Windsurf',
  dotDir: '.windsurf',
  appDataDir: 'Windsurf',
});
checkClient('Devin', {
  installRoot: 'E:/Program/devin',
  dotDir: '.devin',
  appDataDir: 'Devin',
});

// ─────────────────────────────────────────────────────────────
// 汇总
// ─────────────────────────────────────────────────────────────
console.log(`\n════════════════════════════════════`);
console.log(`通过 ${passed} ｜ 失败 ${failed}`);
console.log(failed === 0 ? '✅ 全部通过' : '❌ 存在失败项——必须修复后重跑，任务不得结束');
process.exit(failed === 0 ? 0 : 1);
