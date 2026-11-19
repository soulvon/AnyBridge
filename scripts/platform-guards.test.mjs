import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as hygiene from './lib/key-features/hygiene-and-portability.mjs';

const requireOs = () => os;
const requireChildProcess = () => ({ execFileSync });

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('platform-guards: 精确作用域拦截 80 行窗口假阳性（v1.1.14 gui_probe.rs 事故复现）', () => {
  assert.equal(typeof hygiene.auditRustPlatformGuards, 'function', '应导出 auditRustPlatformGuards 纯审计函数');

  const sample = [
    '#[cfg(windows)]',
    'fn prev_helper() -> Option<String> {',
    '    Some("ok".to_string())',
    '}',
    '',
    'fn unguarded_running_process() {',
    '    use windows_sys::Win32::Foundation::CloseHandle;',
    '    let _ = CloseHandle;',
    '}',
  ].join('\n');

  const report = hygiene.auditRustPlatformGuards([
    { rel: 'src-tauri/src/commands/version_probe/gui_probe.rs', content: sample },
  ]);
  assert.ok(
    report.unguardedWinApi.some((x) => x.includes('gui_probe.rs:7')),
    `应精确拦截脱离前一个 #[cfg(windows)] 作用域的 windows_sys 调用，实际: ${JSON.stringify(report.unguardedWinApi)}`,
  );

  const fixed = sample.replace('fn unguarded_running_process()', '#[cfg(windows)]\nfn unguarded_running_process()');
  const fixedReport = hygiene.auditRustPlatformGuards([
    { rel: 'src-tauri/src/commands/version_probe/gui_probe.rs', content: fixed },
  ]);
  assert.deepEqual(fixedReport.unguardedWinApi, [], '补齐 #[cfg(windows)] 后应零报错');
});

test('platform-guards: 拦截孤悬 #[cfg(...)] 吃掉后续跨平台函数（version_probe / codex_desktop 事故复现）', () => {
  assert.equal(typeof hygiene.auditRustPlatformGuards, 'function');

  const sampleWithBlank = [
    '/// 旧函数注释残留',
    '#[cfg(windows)]',
    '',
    '/// 跨平台函数',
    'pub fn installed_version() -> Option<String> { None }',
  ].join('\n');

  const sampleWithDoc = [
    '#[cfg(target_os = "windows")]',
    '/// 跨平台函数',
    'pub fn kill_codex() -> Result<(), String> { Ok(()) }',
  ].join('\n');

  const report = hygiene.auditRustPlatformGuards([
    { rel: 'src-tauri/src/commands/version_probe/mod.rs', content: sampleWithBlank },
    { rel: 'src-tauri/src/commands/codex_desktop/launch_and_http.rs', content: sampleWithDoc },
  ]);
  assert.ok(
    report.danglingCfgs.some((x) => x.includes('version_probe/mod.rs:2')),
    `应拦截带空行的孤悬 #[cfg(windows)]，实际: ${JSON.stringify(report.danglingCfgs)}`,
  );
  assert.ok(
    report.danglingCfgs.some((x) => x.includes('launch_and_http.rs:1')),
    `应拦截后接 /// doc 注释的孤悬 #[cfg]，实际: ${JSON.stringify(report.danglingCfgs)}`,
  );

  const clean = [
    '/// 平台专属函数',
    '#[cfg(windows)]',
    '#[allow(dead_code)]',
    'fn win_only() {}',
  ].join('\n');
  const cleanReport = hygiene.auditRustPlatformGuards([
    { rel: 'src-tauri/src/commands/demo.rs', content: clean },
  ]);
  assert.deepEqual(cleanReport.danglingCfgs, [], '规范写法（doc 在上、cfg 紧贴 item/其他属性）不得误报');
});

test('platform-guards: 拦截非 Windows 分支缺失 PermissionsExt 与未导入 Command（ca/mod.rs 与 ide_paths.rs 事故复现）', () => {
  assert.equal(typeof hygiene.auditRustPlatformGuards, 'function');

  const caBroken = [
    'use std::fs;',
    'fn generate(dir: &std::path::Path) -> std::io::Result<()> {',
    '    #[cfg(unix)]',
    '    fs::set_permissions(dir, fs::Permissions::from_mode(0o700))?;',
    '    Ok(())',
    '}',
  ].join('\n');

  const ideBroken = [
    '#[cfg(windows)]',
    'use std::process::Command;',
    '#[cfg(not(windows))]',
    'pub fn find_bin() {',
    '    let _ = Command::new("sh").arg("-c").arg("echo hi").output();',
    '}',
  ].join('\n');

  const report = hygiene.auditRustPlatformGuards([
    { rel: 'cursor-core/src/local_app/ca/mod.rs', content: caBroken },
    { rel: 'src-tauri/src/commands/system/ide_paths.rs', content: ideBroken },
  ]);

  assert.ok(
    report.missingUnixImports.some((x) => x.includes('ca/mod.rs:4') && x.includes('PermissionsExt')),
    `应拦截 #[cfg(unix)] 内 from_mode 缺 PermissionsExt，实际: ${JSON.stringify(report.missingUnixImports)}`,
  );
  assert.ok(
    report.missingUnixImports.some((x) => x.includes('ide_paths.rs:5') && x.includes('Command')),
    `应拦截 #[cfg(not(windows))] 内裸 Command::new 缺非 Windows 导入，实际: ${JSON.stringify(report.missingUnixImports)}`,
  );

  const caFixed = [
    'use std::fs;',
    'fn generate(dir: &std::path::Path) -> std::io::Result<()> {',
    '    #[cfg(unix)]',
    '    {',
    '        use std::os::unix::fs::PermissionsExt;',
    '        fs::set_permissions(dir, fs::Permissions::from_mode(0o700))?;',
    '    }',
    '    Ok(())',
    '}',
  ].join('\n');

  const ideFixed = [
    '#[cfg(not(windows))]',
    'pub fn find_bin() {',
    '    let _ = std::process::Command::new("sh").arg("-c").arg("echo hi").output();',
    '}',
  ].join('\n');

  const okReport = hygiene.auditRustPlatformGuards([
    { rel: 'cursor-core/src/local_app/ca/mod.rs', content: caFixed },
    { rel: 'src-tauri/src/commands/system/ide_paths.rs', content: ideFixed },
  ]);
  assert.deepEqual(okReport.missingUnixImports, [], '补齐导入或全限定路径后应零报错');
});

test('platform-guards: 模块级 #[cfg(target_os = "windows")] + #[path = ...] 文件自动识别为 Windows 专属', () => {
  assert.equal(typeof hygiene.auditRustPlatformGuards, 'function');

  const modRs = [
    '#[cfg(target_os = "windows")]',
    '#[path = "platform_win.rs"]',
    'mod platform;',
  ].join('\n');
  const winRs = [
    'use std::os::windows::process::CommandExt;',
    'pub fn run() { let _ = windows_sys::Win32::Foundation::ERROR_SUCCESS; }',
  ].join('\n');

  const report = hygiene.auditRustPlatformGuards([
    { rel: 'src-tauri/src/commands/cert_install/mod.rs', content: modRs },
    { rel: 'src-tauri/src/commands/cert_install/platform_win.rs', content: winRs },
  ]);
  assert.deepEqual(report.unguardedWinApi, [], '通过 #[cfg(target_os = "windows")] #[path = ...] 挂载的文件应识别为已守卫');
});

test('cross-platform CI gates: 非 TTY 断言、Antigravity 真执行三平台环境隔离与 CI/Release 日志路径', () => {
  const isoTest = fs.readFileSync(path.join(root, 'scripts/antigravity-refresh-and-isolation.test.mjs'), 'utf8');
  assert.ok(
    !isoTest.includes('/ℹ pass 12/'),
    'antigravity-refresh-and-isolation.test.mjs 不得写死仅限 TTY 的 spec 输出符号 ℹ pass 12（CI 非 TTY 为 TAP 格式）',
  );

  const agGate = fs.readFileSync(path.join(root, 'scripts/check-antigravity-endpoint.mjs'), 'utf8');
  const trueExecStart = agGate.indexOf('注入片段可真实执行并读出端点（真执行）');
  const trueExecBlock = agGate.slice(trueExecStart, trueExecStart + 2600);
  for (const envVar of ['APPDATA', 'LOCALAPPDATA', 'USERPROFILE', 'HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME']) {
    assert.ok(
      trueExecBlock.includes(envVar),
      `check-antigravity-endpoint.mjs 真执行块必须隔离并设置 ${envVar}，否则 Linux/macOS CI 必失败或穿透宿主机`,
    );
  }

  const ciYml = fs.readFileSync(path.join(root, '.github/workflows/ci.yml'), 'utf8');
  const relYml = fs.readFileSync(path.join(root, '.github/workflows/release.yml'), 'utf8');
  assert.ok(
    !ciYml.includes('tee verify.log') && !ciYml.includes('tail -80 verify.log'),
    'ci.yml 不得把 verify.log 写在仓库根目录（会被 runTempFileDiscipline 自动迁入 tmp/ 导致 Verify report 报 No such file）',
  );
  assert.ok(
    ciYml.includes('RUNNER_TEMP') && relYml.includes('RUNNER_TEMP'),
    'ci.yml 与 release.yml 的构建/校验日志必须写到 RUNNER_TEMP 避免污染仓库根目录',
  );
  assert.ok(
    ciYml.includes('--manifest-path cursor-core/Cargo.toml --release')
      && ciYml.includes('--manifest-path src-tauri/Cargo.toml --release'),
    'ci.yml 非 Windows release 预检必须同时覆盖 src-tauri 与 cursor-core',
  );
  assert.ok(
    ciYml.includes("name: Cargo check (release profile, non-Windows)\n        if: runner.os != 'Windows'"),
    'ci.yml release 预检应覆盖全部非 Windows 平台（Linux + macOS），而非仅 Linux',
  );
});

test('cross-platform CI gates: Antigravity 注入模板在 win32 / darwin / linux 三平台模拟下真执行均读出端点', () => {
  const rs = fs.readFileSync(path.join(root, 'src-tauri/src/commands/platforms/antigravity_patch.rs'), 'utf8');
  const extractRaw = (fnName) => {
    const idx = rs.indexOf(`fn ${fnName}(`);
    assert.ok(idx >= 0, `未找到 ${fnName}`);
    const m = /r#"([\s\S]*?)"#/.exec(rs.slice(idx, idx + 12000));
    assert.ok(m, `未提取到 ${fnName} raw string`);
    return m[1];
  };
  const candsTpl = extractRaw('antigravity_settings_candidates_js');
  const ideTpl = extractRaw('antigravity_ide_extension_injection');
  const hubTpl = extractRaw('antigravity_hub_endpoint_injection');
  const readTpl = extractRaw('antigravity_settings_read_js');
  const ideNames = /const ANTIGRAVITY_IDE_SETTINGS_NAMES: &str =\s*r#"([\s\S]*?)"#/.exec(rs)?.[1];
  const hubNames = /const ANTIGRAVITY_HUB_SETTINGS_NAMES: &str =\s*r#"([\s\S]*?)"#/.exec(rs)?.[1];
  assert.ok(ideNames && hubNames);

  const render = (tpl, nm) => tpl
    .replace('__AB_CANDS__', candsTpl.replace('__AB_NAMES__', nm))
    .replace('__AB_READ__', readTpl)
    .replace('__AB_V2__', '/*V*/')
    .replace('__AB_MARKER__', '/*M*/');
  const ideSrc = render(ideTpl, ideNames);
  const hubSrc = render(hubTpl, hubNames);

  const os = requireOs();
  const { execFileSync } = requireChildProcess();
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-xplat-sim-'));
  try {
    for (const [name, url] of [
      ['Antigravity IDE', 'https://localhost:7452'],
      ['Antigravity', 'https://localhost:9999'],
    ]) {
      const d = path.join(tmpRoot, name, 'User');
      fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(path.join(d, 'settings.json'), `// jsonc\n{\n  "jetski.cloudCodeUrl": "${url}",\n}`);
    }
    const script = path.join(tmpRoot, 'sim.cjs');
    fs.writeFileSync(script, [
      "const fs=require('fs'),os=require('os'),path=require('path');",
      `const ideSrc=${JSON.stringify(ideSrc)};`,
      `const hubSrc=${JSON.stringify(hubSrc)};`,
      'const plat=process.argv[2];',
      'Object.defineProperty(process,"platform",{value:plat});',
      'const ide=eval(ideSrc)({});',
      'const hub=eval(hubSrc);',
      'console.log(JSON.stringify({plat,ide:ide.CLOUD_CODE_URL||null,hub}));',
    ].join('\n'), 'utf8');

    const isolatedEnv = {
      ...process.env,
      NODE_OPTIONS: '',
      APPDATA: tmpRoot,
      LOCALAPPDATA: tmpRoot,
      USERPROFILE: tmpRoot,
      HOME: tmpRoot,
      XDG_CONFIG_HOME: tmpRoot,
      XDG_DATA_HOME: tmpRoot,
    };
    delete isolatedEnv.ANYBRIDGE_ANTIGRAVITY_SETTINGS;

    for (const plat of ['win32', 'darwin', 'linux']) {
      const out = execFileSync(process.execPath, [script, plat], {
        encoding: 'utf8',
        stdio: 'pipe',
        env: isolatedEnv,
      }).trim();
      const parsed = JSON.parse(out);
      assert.equal(parsed.ide, 'https://localhost:7452', `${plat} 模拟下 IDE 注入块应读出端点，实际 ${out}`);
      assert.equal(parsed.hub, 'https://localhost:9999', `${plat} 模拟下 Hub 注入块应读出端点，实际 ${out}`);
    }
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('platform-guards: 真实代码库全量扫描（src-tauri + cursor-core）零违规', () => {
  assert.equal(typeof hygiene.scanRustPlatformGuards, 'function', '应导出 scanRustPlatformGuards');
  const report = hygiene.scanRustPlatformGuards(root);
  assert.deepEqual(report.unguardedWinApi, [], `存在未守卫 Windows API: ${report.unguardedWinApi.join(', ')}`);
  assert.deepEqual(report.danglingCfgs, [], `存在孤悬 #[cfg]: ${report.danglingCfgs.join(', ')}`);
  assert.deepEqual(report.missingUnixImports, [], `存在非 Windows 分支缺失导入: ${report.missingUnixImports.join(', ')}`);
});
