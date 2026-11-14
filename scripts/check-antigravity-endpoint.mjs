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
// 函数可能带参数，用「fn <name>(」定位而非精确空参签名。
function extractRawString(source, fnName) {
  const idx = source.indexOf(`fn ${fnName}(`);
  if (idx < 0) return null;
  const m = /r#"([\s\S]*?)"#/.exec(source.slice(idx, idx + 12000));
  return m ? m[1] : null;
}
// 渲染模板：与 Rust 侧一致的显式占位符替换（不再依赖 format! 花括号转义）。
// v1.1.5 事故教训：模板必须用 __AB_*__ 这类不会与 JS 语法冲突的占位符。
function renderTemplate(template, values) {
  let out = template;
  for (const [k, v] of Object.entries(values)) out = out.split(k).join(v);
  return out;
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
  const candidatesTpl = extractRawString(rs, 'antigravity_settings_candidates_js');
  ok('按端隔离的 settings 候选模板存在', !!candidatesTpl);
  if (candidatesTpl) {
    const ideNames = /const ANTIGRAVITY_IDE_SETTINGS_NAMES: &str =\s*r#"([\s\S]*?)"#/.exec(rs)?.[1];
    const hubNames = /const ANTIGRAVITY_HUB_SETTINGS_NAMES: &str =\s*r#"([\s\S]*?)"#/.exec(rs)?.[1];
    ok('两端目录名分别定义且互不混用',
      !!ideNames && !!hubNames && ideNames.includes('Antigravity IDE') && !ideNames.includes('"Antigravity"')
      && hubNames.includes('"Antigravity"') && !hubNames.includes('Antigravity IDE'));
    const rendered = renderTemplate(candidatesTpl, { __AB_NAMES__: ideNames || '[]' });
    ok('候选片段是合法 JS', nodeCheck('candidates', `const cands=${rendered};`));
    ok('按当前用户主目录推导（不硬编码用户名）', rendered.includes('os.homedir') && !/C:[\\/]Users[\\/]\w+/.test(rendered));
    ok('覆盖 Windows APPDATA / macOS Application Support / Linux XDG',
      rendered.includes('APPDATA') && rendered.includes('Application Support') && rendered.includes('XDG_CONFIG_HOME'));
    ok('覆盖便携版 --user-data-dir', rendered.includes('--user-data-dir'));
    ok('支持自定义配置路径显式覆盖', rendered.includes('ANYBRIDGE_ANTIGRAVITY_SETTINGS'));
    ok('候选只扫描本端目录名（不硬编码全部产品名）',
      candidatesTpl.includes('__AB_NAMES__') && !candidatesTpl.includes('"Antigravity","antigravity-ide"'));
    // v1.1.5 事故：`names={names}` 未被替换，运行时抛错被 catch 吞掉，
    // 注入静默失效。渲染结果绝不能残留任何占位符或未展开的 `{names}`。
    ok('渲染后无未替换占位符', !/__AB_[A-Z_]+__/.test(rendered) && !rendered.includes('{names}'));
    ok('渲染后 names 是真实数组字面量', /names=\["/.test(rendered));
    // 真执行：注入块必须真的能读到端点（语法正确不等于逻辑正确）。
    ok('注入片段可真实执行并读出端点（真执行）', (() => {
      const names = /const ANTIGRAVITY_IDE_SETTINGS_NAMES: &str =\s*r#"([\s\S]*?)"#/.exec(rs)?.[1];
      const namesHub = /const ANTIGRAVITY_HUB_SETTINGS_NAMES: &str =\s*r#"([\s\S]*?)"#/.exec(rs)?.[1];
      const ideTpl = extractRawString(rs, 'antigravity_ide_extension_injection');
      const hubTpl = extractRawString(rs, 'antigravity_hub_endpoint_injection');
      const readTpl = extractRawString(rs, 'antigravity_settings_read_js');
      if (!names || !namesHub || !ideTpl || !hubTpl || !readTpl) return false;
      const render = (tpl, nm) => tpl
        .replace('__AB_CANDS__', candidatesTpl.replace('__AB_NAMES__', nm))
        .replace('__AB_READ__', readTpl)
        .replace('__AB_V2__', '/*V*/')
        .replace('__AB_MARKER__', '/*M*/');
      const ide = render(ideTpl, names);
      const hub = render(hubTpl, namesHub);
      const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-gate-'));
      const mk = (n, u) => {
        const d = path.join(tmpRoot, n, 'User');
        fs.mkdirSync(d, { recursive: true });
        // 真机形状（2026-11-14 事故）：settings.json 是 JSONC——注释与尾逗号
        // 合法，严格 JSON.parse 会抛错被 catch 吞掉 → 注入静默回退官方端点。
        // fixture 必须带注释 + 尾逗号，逼容错读取在每次 verify 真执行中自证。
        fs.writeFileSync(path.join(d, 'settings.json'),
          `// client-managed settings (JSONC)\n{\n  // gateway endpoint\n  "jetski.cloudCodeUrl": "${u}",\n}`);
      };
      mk('Antigravity IDE', 'https://localhost:7452');
      mk('Antigravity', 'https://localhost:9999');
      // 必须用 .cjs：打包时 TEMP 会被指到项目树内（WiX 路径需求），
      // 项目 package.json 是 "type":"module"，.js 会被 ESM 解析导致
      // require is not defined（esm/loader 崩溃）。.cjs 强制 CJS，免疫。
      const script = path.join(tmpRoot, 'run.cjs');
      fs.writeFileSync(script, [
        "const fs=require('fs'),os=require('os'),path=require('path');",
        `const ideSrc=${JSON.stringify(ide)};`,
        `const hubSrc=${JSON.stringify(hub)};`,
        `process.env.APPDATA=${JSON.stringify(tmpRoot)};`,
        `process.env.LOCALAPPDATA=${JSON.stringify(tmpRoot)};`,
        'delete process.env.ANYBRIDGE_ANTIGRAVITY_SETTINGS;',
        'const ide=eval(ideSrc)({});',
        'const hub=eval(hubSrc);',
        'console.log(JSON.stringify({ide:ide.CLOUD_CODE_URL||null,hub:hub}));',
      ].join('\n'), 'utf8');
      try {
        // 隔离宿主注入的 NODE_OPTIONS（AI IDE 的 --require shim 在高负载下
        // 会加载失败导致 node 退出，见 docs/pitfalls.json 同名条目）
        const isolatedEnv = { ...process.env, NODE_OPTIONS: '' };
        const out = execFileSync(process.execPath, [script], { encoding: 'utf8', stdio: 'pipe', env: isolatedEnv });
        const pass = out.includes('"ide":"https://localhost:7452"') && out.includes('"hub":"https://localhost:9999"');
        if (!pass) console.log(`    [真执行诊断] stdout=${out.slice(0, 500)}`);
        return pass;
      } catch (error) {
        console.log(`    [真执行诊断] spawn 失败: ${String(error.message).slice(0, 300)}`);
        console.log(`    [真执行诊断] stderr=${String(error.stderr || '').slice(0, 500)}`);
        return false;
      }
      finally { try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {} }
    })());
  }
  ok('黑底注入块绑定 env 对象而非硬编码 minify 名', rs.includes('e.CLOUD_CODE_URL=v.trim()'));
  ok('白底注入块自带 require（不依赖顶部导入）', rs.includes('antigravity_hub_endpoint_injection') && rs.includes('require("fs")'));
  ok('注入前保留备份文件', rs.includes('js.anybridge-bak') && rs.includes('app.asar.official.bak'));
}

section('还原对称：杜绝 v1.1.0 死端点事故');
{
  // 事故根因：注入块只写不删，父进程继承的 CLOUD_CODE_URL 在撤键后仍把
  // agy.exe 钉在已停掉的本地网关上 → userInfo 失败 → 切号插件失效。
  ok('黑底注入块先清除继承的 CLOUD_CODE_URL', rs.includes('delete e.CLOUD_CODE_URL'));
  ok('白底 fallback 不读脏环境变量', (() => {
    // 单测里的「杂交残尸」fixture 故意带旧版脏环境变量尾巴，全文正则会误伤；
    // 判据只针对注入模板函数体本身，语义不变。
    const start = rs.indexOf('fn antigravity_hub_endpoint_injection');
    if (start < 0) return false;
    const end = rs.indexOf('\nfn ', start + 1);
    const body = rs.slice(start, end > start ? end : rs.length);
    return !/return process\.env\.CLOUD_CODE_URL/.test(body);
  })());
  ok('白底 fallback 回官方端点', /return 'https:\/\/daily-cloudcode-pa\.googleapis\.com'/.test(rs));
  ok('两端注入各自使用本端目录名',
    rs.includes('antigravity_settings_candidates_js(ANTIGRAVITY_IDE_SETTINGS_NAMES)')
    && rs.includes('antigravity_settings_candidates_js(ANTIGRAVITY_HUB_SETTINGS_NAMES)'));
  ok('黑底还原也终止语言服务（清掉继承环境块）',
    (() => {
      const start = rs.indexOf('fn apply_antigravity_ide_official_with_stash');
      const end = rs.indexOf('fn apply_antigravity_official(', start);
      return start >= 0 && end > start && rs.slice(start, end).includes('kill_antigravity_language_server()');
    })());
  ok('门控含还原后死端点回归测试', rs.includes('antigravity_restore_clears_inherited_endpoint'));
  ok('成套还原清理两端残留托管端点', rs.includes('fn clear_antigravity_stale_managed_endpoints'));
  ok('两条还原路径（含字段级早退分支）都调用成套清理',
    (rs.match(/clear_antigravity_stale_managed_endpoints\(\)/g) || []).length >= 4);
  ok('终止 LS 同时覆盖白底 language_server 与黑底 agy.exe',
    rs.includes('is_hub_ls') && rs.includes('is_ide_ls') && rs.includes('.gemini') && rs.includes('bin') && rs.includes('agy.exe'));
  ok('注入块有版本号且旧版会自动升级',
    rs.includes('ANTIGRAVITY_IDE_EXTENSION_VERSION') && rs.includes('ANTIGRAVITY_HUB_ENDPOINT_VERSION')
    && rs.includes('strip_antigravity_extension_injection'));
  ok('幂等判据只认当前版本（不认旧 marker）',
    rs.includes('original.contains(ANTIGRAVITY_IDE_EXTENSION_VERSION)')
    && rs.includes('c.contains(ANTIGRAVITY_HUB_ENDPOINT_VERSION)')
    && rs.includes('code.contains(ANTIGRAVITY_HUB_ENDPOINT_VERSION)'));
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
    rs.includes("['\"]--cloud_code_endpoint['\"]") && rs.includes('\\(\\(\\)\\s*=>\\s*\\{.*\\}\\)\\(\\)'));
  ok('2.32.1+ 常量形态：节点选择 + LS_CLOUD_CODE_ENDPOINT 都支持',
    rs.includes('lsDefaults.js') && rs.includes('fn hub_endpoint_node_name')
    && rs.includes('exports\\.LS_CLOUD_CODE_ENDPOINT') && rs.includes('baseLsArgs'));
  ok('汉化还原判据跟随同一节点选择', loc.includes('hub_endpoint_node_name'));
  ok('白底预检只认当前版本 marker（旧注入继续自愈）',
    rs.includes('c.contains(ANTIGRAVITY_HUB_ENDPOINT_VERSION)') && rs.includes('老版本留下的旧注入'));
  ok('旧版形态单测覆盖 ≥5 种黑底 + ≥4 种白底',
    rs.includes('legacy_plain_export') && rs.includes('legacy_old_injection_selfheal'));
}

section('2.32.1：lsDefaults.js 常量形态');
{
  const hubTpl = extractRawString(rs, 'antigravity_hub_endpoint_injection');
  const candsTpl = extractRawString(rs, 'antigravity_settings_candidates_js');
  const readTpl = extractRawString(rs, 'antigravity_settings_read_js');
  const namesHub = /const ANTIGRAVITY_HUB_SETTINGS_NAMES: &str =\s*r#"([\s\S]*?)"#/.exec(rs)?.[1];
  ok('2.32.1 模板可提取', !!hubTpl && !!candsTpl && !!namesHub && !!readTpl);
  if (hubTpl && candsTpl && namesHub && readTpl) {
    const injection = renderTemplate(hubTpl, {
      __AB_CANDS__: candsTpl.replace('__AB_NAMES__', namesHub),
      __AB_READ__: readTpl,
      __AB_V2__: '/*ANYBRIDGE_CLOUD_CODE_ENDPOINT_V5*/',
      __AB_MARKER__: '/*ANYBRIDGE_CLOUD_CODE_ENDPOINT*/',
    });
    const src = [
      '"use strict";',
      'exports.LS_CLOUD_CODE_ENDPOINT = exports.LS_API_SERVER_URL = void 0;',
      'exports.baseLsArgs = baseLsArgs;',
      "exports.LS_API_SERVER_URL = 'https://generativelanguage.googleapis.com';",
      `exports.LS_CLOUD_CODE_ENDPOINT = ${injection};`,
      "function baseLsArgs(opts){return ['--cloud_code_endpoint', exports.LS_CLOUD_CODE_ENDPOINT];}",
    ].join('\n');
    ok('常量替换后整文件语法合法', nodeCheck('ls_defaults', src));
    ok('baseLsArgs 仍引用常量且官方兜底只一份',
      src.includes("'--cloud_code_endpoint', exports.LS_CLOUD_CODE_ENDPOINT")
      && (src.match(/https:\/\/daily-cloudcode-pa\.googleapis\.com/g) || []).length === 1);
    // 2026-11-14 事故判据：JSONC（注释/尾逗号）settings 必须能读出端点。
    // 严格 JSON.parse 的读法曾在全绿测试下真机失效——这里用真机形状逼真执行。
    const jsoncProbe = `const f=process.argv[1],fs=require("fs");const v=${readTpl.replace(/\bf\b/g, 'f')};console.log(JSON.stringify(v||null));`;
    ok('JSONC 容错读取片段：注释+尾逗号 settings 可读出端点', (() => {
      const tmp = path.join(os.tmpdir(), `ab-gate-jsonc-${process.pid}.json`);
      fs.writeFileSync(tmp, '// 注释\n{\n  "jetski.cloudCodeUrl": "https://localhost:7452",\n}', 'utf8');
      try {
        const isolatedEnv = { ...process.env, NODE_OPTIONS: '' };
        const out = execFileSync(process.execPath, ['-e', jsoncProbe, tmp], { encoding: 'utf8', stdio: 'pipe', env: isolatedEnv });
        return out.trim() === '"https://localhost:7452"';
      } catch { return false; }
      finally { try { fs.unlinkSync(tmp); } catch {} }
    })());
    ok('JSONC 容错读取片段不误伤 https:// 里的 //',
      /[^:"']\/\//.test(readTpl) && readTpl.includes('[^:"\']'));
  }
  ok('JSONC 读取片段被黑底与白底模板共用（收敛到一处）',
    (rs.match(/__AB_READ__/g) || []).length >= 2 && rs.includes('antigravity_settings_read_js'));
  ok('候选构建剥离 --user-data-dir 的引号包裹（真机 argv 形状）',
    candsTpl.includes('.replace(/^"(.*)"$/,"$1")'));
  ok('Rust 单测覆盖 2.32.1 形态与节点选择',
    rs.includes('antigravity_hub_patch_supports_ls_defaults_shape')
    && rs.includes('antigravity_hub_endpoint_node_prefers_ls_defaults'));
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
    rs.includes('apply_antigravity_ide_official_with_stash')
    && rs.includes('write_settings_endpoint(path, None)')
    && rs.includes('delete e.CLOUD_CODE_URL'));
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
