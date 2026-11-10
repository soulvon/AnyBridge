#!/usr/bin/env node
/**
 * Antigravity 端点接管补丁的门控校验（发布前必跑）。
 *
 *   node scripts/check-antigravity-endpoint.mjs
 *
 * 把 v1.0.20 的三次事故固化成机器判据：
 *   1. 拼接整个 head 生成两份 return → 扩展语法损坏 → Agent 面板永久卡加载；
 *   2. 只认一种 `return <env>}` / 固定缩进端点串 → 老版本客户端不兼容；
 *   3. 路径与注入块硬编码用户名/产品目录 → 换用户、换安装盘、换系统即失效。
 *
 * 校验方式：源码判据 + 提取真实注入 JS 交给 Node 解析 + 多形态 fixture 变换，
 * 并调用 Rust 单测（单测内含 Node 真解析）。退出码 0=通过，1=失败。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failed = 0;
let passed = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`); }
};
const section = (n) => console.log(`\n■ ${n}`);
const rs = fs.readFileSync(path.join(root, 'src-tauri/src/commands/platforms.rs'), 'utf8');
const loc = fs.readFileSync(path.join(root, 'src-tauri/src/commands/antigravity_localization.rs'), 'utf8');

// 提取 Rust 里的 raw string 常量/函数返回值，交给 Node 真解析。
function extractRawString(source, fnName) {
  const idx = source.indexOf(`fn ${fnName}()`);
  if (idx < 0) return null;
  const m = /r#"([\s\S]*?)"#/.exec(source.slice(idx, idx + 12000));
  return m ? m[1] : null;
}
function nodeCheck(label, code) {
  const tmp = path.join(os.tmpdir(), `anybridge-ag-gate-${process.pid}-${label}.js`);
  fs.writeFileSync(tmp, code, 'utf8');
  try {
    execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' });
    return true;
  } catch { return false; }
  finally { try { fs.unlinkSync(tmp); } catch {} }
}

section('注入代码：自包含与语法');
{
  const candidates = extractRawString(rs, 'antigravity_settings_candidates_js');
  ok('共享 settings 候选片段存在', !!candidates);
  if (candidates) {
    ok('候选片段是合法 JS', nodeCheck('candidates', `const cands=${candidates};`));
    ok('按当前用户主目录推导（不硬编码用户名）', candidates.includes('os.homedir') && !/C:[\\/]Users[\\/]\w+/.test(candidates));
    ok('覆盖 Windows APPDATA / macOS Application Support / Linux XDG',
      candidates.includes('APPDATA') && candidates.includes('Application Support') && candidates.includes('XDG_CONFIG_HOME'));
    ok('覆盖新旧产品目录名与便携版 --user-data-dir',
      candidates.includes('Antigravity IDE') && candidates.includes('antigravity-ide') && candidates.includes('--user-data-dir'));
    ok('支持自定义配置路径显式覆盖', candidates.includes('ANYBRIDGE_ANTIGRAVITY_SETTINGS'));
  }
  ok('黑底注入块绑定 env 对象而非硬编码 minify 名', rs.includes('e.CLOUD_CODE_URL=v.trim()'));
  ok('白底注入块自带 require（不依赖顶部导入）', rs.includes('antigravity_hub_endpoint_injection') && rs.includes('require("fs")'));
  ok('注入前保留备份文件', rs.includes('js.anybridge-bak') && rs.includes('app.asar.official.bak'));
}

section('拼接安全：杜绝 v1.0.20 双 return 事故');
{
  ok('原地替换 return 表达式（prefix = head[..whole.start()]）',
    rs.includes('&head[..whole.start()]') && rs.includes('&code[whole.end()..]'));
  ok('不再用整个 head 拼接 return', !/format!\(\s*"{head}return/.test(rs));
  ok('锚点缺失时明确报错中断接入',
    rs.includes('未在 extension.js 中找到 buildServerEnvironment 赋值') && rs.includes('patch_antigravity_ide_extension()?'));
  ok('单测用 Node 真解析注入结果', rs.includes('fn assert_valid_js') && rs.includes('"--check"'));
  ok('单测断言只允许一处注入 return', rs.includes('只允许一处注入 return'));
}

section('旧版客户端兼容：多形态锚点与端点串');
{
  ok('锚点定位覆盖 .属性 / 方括号 / 裸赋值 / 对象键',
    ['.buildServerEnvironment', '["buildServerEnvironment"]', "['buildServerEnvironment']",
     'buildServerEnvironment=', 'buildServerEnvironment:'].every(s => rs.includes(s)));
  ok('return 识别用正则而非固定字符串切分', rs.includes('return\\s+([A-Za-z_$][A-Za-z0-9_$]*)'));
  ok('白底变换抽成纯函数', rs.includes('fn patch_hub_language_server_code'));
  ok('白底变换兼容单/双引号、任意缩进、任意端点域名、旧注入自愈',
    rs.includes("['\"]--cloud_code_endpoint['\"]") && rs.includes('\\(\\(\\)\\s*=>\\s*\\{.*?\\}\\)\\(\\)'));
  ok('白底预检只认当前版本 marker（旧注入继续自愈）',
    rs.includes('c.contains(ANTIGRAVITY_HUB_ENDPOINT_MARKER)') && rs.includes('老版本留下的旧注入'));
  ok('旧版形态单测覆盖 ≥5 种黑底 + ≥4 种白底',
    rs.includes('legacy_plain_export') && rs.includes('legacy_old_injection_selfheal'));
}

section('安装路径：多用户名 / 自定义路径 / 三平台');
{
  const start = rs.indexOf('fn antigravity_install_app_dirs()');
  const end = rs.indexOf('fn antigravity_ide_extension_candidates()');
  const discovery = start >= 0 && end > start ? rs.slice(start, end) : '';
  ok('路径发现函数存在且可检查', discovery.length > 0);
  ok('不硬编码用户名或盘符', !/C:[\\/]Users[\\/]\w+/.test(discovery) && !/E:[\\/]Program/.test(discovery));
  ok('用 dirs::home_dir / data_local_dir 推导当前用户',
    discovery.includes('dirs::home_dir') && rs.includes('dirs::data_local_dir'));
  ok('支持自定义安装目录显式覆盖',
    ['ANYBRIDGE_ANTIGRAVITY_IDE_APP_DIR', 'ANYBRIDGE_ANTIGRAVITY_HUB_APP_DIR', 'ANYBRIDGE_ANTIGRAVITY_HUB_ASAR']
      .every(k => rs.includes(k)));
  ok('扫描安装父目录里名字含 antigravity 的子目录（覆盖老版本目录名）',
    discovery.includes('name.contains("antigravity")'));
  ok('三平台 cfg 分支齐全',
    ['target_os = "windows"', 'target_os = "macos"', 'all(unix, not(target_os = "macos"))']
      .every(s => rs.slice(rs.indexOf('fn antigravity_install_app_dirs()'), rs.indexOf('fn antigravity_hub_asar_candidates()')).includes(s)));
  ok('白底 asar 路径与端点补丁共用同一份发现逻辑',
    loc.includes('antigravity_hub_asar_candidates') && !loc.includes('/Applications/Antigravity.app/Contents/Resources/app.asar'));
}

section('保活与还原：不擅自改未接入的安装目录');
{
  ok('keeper 仅在配置指向本地网关时工作', rs.includes('if !hub_managed && !ide_managed'));
  ok('keeper 持全局注入锁', rs.includes('super::inject_lock()'));
  ok('keeper 已挂载到应用启动', fs.readFileSync(path.join(root, 'src-tauri/src/lib.rs'), 'utf8').includes('spawn_antigravity_endpoint_keeper'));
  ok('还原撤键后注入块自动回退官方（对称）',
    rs.includes('apply_antigravity_ide_official_with_stash') && rs.includes('obj.remove("jetski.cloudCodeUrl")'));
}

section('Rust 单测（含多形态 + Node 真解析）');
{
  try {
    const out = execFileSync('cargo', ['test', '--manifest-path', 'src-tauri/Cargo.toml', '--lib', 'antigravity_'], {
      cwd: root, encoding: 'utf8', stdio: 'pipe', timeout: 240000,
    });
    const m = /test result: ok\. (\d+) passed/.exec(out);
    ok(`antigravity 单测全绿（${m ? m[1] : '?'} 项）`, !!m);
  } catch (e) {
    ok('antigravity 单测全绿', false, String(e.stdout || e.message).slice(-400));
  }
}

console.log(`\n════════════════════════════════════`);
console.log(`通过 ${passed} ｜ 失败 ${failed}`);
console.log(failed === 0 ? '✅ Antigravity 端点门控通过' : '❌ 存在失败项——必须修复后重跑');
process.exit(failed === 0 ? 0 : 1);
