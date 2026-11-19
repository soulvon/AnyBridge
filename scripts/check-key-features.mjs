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
const mode = (process.argv[2] || 'all').replace(/^--/, '');
if (!['all', 'fast', 'rust', 'live'].includes(mode)) {
  console.error(`未知检查模式: ${mode}；可选 all、fast、rust、live`);
  process.exit(2);
}
const runFast = mode === 'all' || mode === 'fast';
const runRust = mode === 'all' || mode === 'rust';
const runLive = mode === 'all' || mode === 'live';
let failed = 0;
let passed = 0;
let warned = 0;

function ok(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`); }
}
// 提示档：可见但不阻断，用于存量风格债务；硬规则由 ok() 承担
function warn(name, detail = '') {
  warned++;
  console.log(`  ⚠ 提示 ${name}${detail ? ' — ' + detail : ''}`);
}
function section(name) { console.log(`\n■ ${name}`); }

import {
  printStartupManifest,
  runPitfallsCheck,
  runSymmetryChecks,
} from './lib/key-features/pitfalls-and-symmetry.mjs';
import {
  runCommitHygiene,
  runPathPortability,
  runPlatformGuards,
  runTempFileDiscipline,
} from './lib/key-features/hygiene-and-portability.mjs';
import {
  runActionReachability,
  runDynamicLoadingChecks,
  runCodebaseStructureChecks,
  runProviderPresetChecks,
} from './lib/key-features/ui-guards-and-presets.mjs';
import {
  runAgentSpecChecks,
  runRegressionAssertions,
} from './lib/key-features/regression-and-agent.mjs';

const ctx = { root, ok, warn, section };

printStartupManifest(ctx);

// ─────────────────────────────────────────────────────────────
// [1] Rust 编译与单测
// ─────────────────────────────────────────────────────────────
if (runRust) {
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
    // 完整输出不截断：flaky 测试的根因往往在 stderr 尾部，截断会把线索切掉
    ok('cargo test 全量单测通过', false, (e.stdout || e.message || '').slice(-3000));
  }
}

// ─────────────────────────────────────────────────────────────
// [2] UI 脚本语法（运行时动态加载，build:ui 不校验它们）
// ─────────────────────────────────────────────────────────────
if (runFast) {
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

section('坑点库（docs/pitfalls.json 逐条验证）');
runPitfallsCheck(ctx);

section('对称路径（接入↔还原 / apply↔restore 必须一致）');
runSymmetryChecks(ctx);

section('临时文件纪律（只允许 tmp/）');
runTempFileDiscipline(ctx);

section('提交卫生（不该提交的不提交）');
runCommitHygiene(ctx);

section('路径可移植性（禁止硬编码盘符/用户目录/安装路径）');
runPathPortability(ctx);

section('平台守卫（Windows API 需 cfg 守卫）');
runPlatformGuards(ctx);

section('data-action 处理器可达性（点击必须有反馈）');
runActionReachability(ctx);

section('加载态动态化（禁止静态 loading 文案）');
{
  const { handmade, feedbackOk, spinnerCssOk } = runDynamicLoadingChecks(ctx);
  ok('spinner 只有一套实现（禁止自造 btn-spinner 叠加成双圈）',
    handmade.length === 0,
    handmade.slice(0, 6).join(' | '));
  ok('loadingHtml / setLoading 已提供且挂到 globalThis', feedbackOk);
  ok('spinner 动画样式存在', spinnerCssOk);
}

section('Agent 声明表（扩展入口）');
runAgentSpecChecks(ctx);

section('关键判据（源码级回归断言）');
runRegressionAssertions(ctx);

// ─────────────────────────────────────────────────────────────
// [3.8] UI 设计铁律守卫：全部已清零并升格为硬阻断守卫
// ─────────────────────────────────────────────────────────────
section('UI 设计铁律守卫（ui-src + ui/assets）');
{
  const uiFiles = [];
  const collectUi = (dir) => {
    const abs = path.join(root, dir);
    if (!fs.existsSync(abs)) return;
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
      if (e.name === 'node_modules') continue;
      const rel = `${dir}/${e.name}`;
      if (e.isDirectory()) collectUi(rel);
      else if (/\.(html|css|js)$/i.test(e.name)) uiFiles.push(rel);
    }
  };
  collectUi('ui-src');
  collectUi('ui/assets');
  ok('UI 源文件可扫描', uiFiles.length > 0, '未收集到 ui-src / ui-assets 文件');

  const scanUi = (re) => {
    const hits = [];
    for (const rel of uiFiles) {
      const src = fs.readFileSync(path.join(root, rel), 'utf8');
      const m = src.match(re);
      if (m && m.length) hits.push({ file: rel, count: m.length });
    }
    return hits;
  };
  const topFiles = (hits) => hits.sort((a, b) => b.count - a.count).slice(0, 3)
    .map(h => `${h.file}(${h.count})`).join(', ');

  // [硬] 全大写英文标签（设计铁律 7）
  const upper = scanUi(/text-transform:\s*uppercase/gi);
  ok('全大写英文标签已清零（text-transform: uppercase）', upper.length === 0,
    topFiles(upper));

  // [硬] 被禁的廉价动效关键帧（雷达波纹/呼吸微光类，设计铁律 6）
  const bannedAnim = scanUi(/@keyframes\s+[\w-]*(?:breath|ripple|wave|扩散|波纹|呼吸|微光)[\w-]*/gi);
  ok('被禁动效关键帧为零（breath/ripple/wave 类）', bannedAnim.length === 0,
    topFiles(bannedAnim));

  // [硬] 非骨架屏廉价装饰动效关键帧（pulse/glow/shimmer，skeleton.css 骨架屏豁免）
  const softAnim = scanUi(/@keyframes\s+[\w-]*(?:pulse|glow|shimmer)[\w-]*/gi)
    .filter(h => !/skeleton/i.test(h.file));
  ok('非骨架屏廉价动效关键帧为零（pulse/glow/shimmer）', softAnim.length === 0,
    topFiles(softAnim));

  // [硬] 蓝紫系 AI 模板色值清零
  const purple = scanUi(/#(?:6366f1|818cf8|4f46e5|4338ca|8b5cf6|7c3aed|6d28d9|a78bfa|c4b5fd|9333ea|7e22ce)\b/gi);
  ok('蓝紫系 AI 模板色值已清零', purple.length === 0,
    topFiles(purple));

  // [硬] 全局字号底线（设计铁律 5：>= 12px）
  const smallFont = scanUi(/font-size:\s*(?:[0-9]|1[01])(?:\.\d+)?px\b/gi);
  ok('全局字号均 >= 12px（<12px 已清零）', smallFont.length === 0,
    topFiles(smallFont));

  // [硬] 左侧彩条装饰（设计铁律 12）
  const leftBar = scanUi(/border-left(?:-width)?:\s*[1-9]\d*px/g);
  ok('左侧彩条装饰已清零（border-left）', leftBar.length === 0,
    topFiles(leftBar));

  // [硬] [hidden] 属性防穿透兜底（devloop 规则 #40：禁止 display:flex !important 穿透 [hidden]）
  const foundationCss = fs.readFileSync(path.join(root, 'ui/assets/styles/00-foundation.css'), 'utf8');
  const hiddenGuard = /\[hidden\][\s\S]{0,160}?display:\s*none\s*!important/.test(foundationCss);
  ok('[hidden] 防穿透规则就位（display: none !important）', hiddenGuard,
    'ui/assets/styles/00-foundation.css 缺少 [hidden] { display: none !important }');

  // [硬] 面板内嵌状态条贴边（设计铁律 3 安全间距；坑点 panel-status-bar-hugs-edge）：
  //   自带 padding 的面板（.model-panel：header 20px / toolbar 16px / custom 20px）里，
  //   同层插入的状态条必须补水平 margin，不得零边距贴面板边框（事故：供应商编辑页拉取结果条左右贴边）
  const readCssWithImports = (relPath) => {
    const absPath = path.join(root, relPath);
    const dir = path.dirname(absPath);
    const raw = fs.readFileSync(absPath, 'utf8');
    return raw.replace(/@import\s+url\(['"]?([^'")]+)['"]?\)\s*;/g, (_, sub) => {
      const target = path.resolve(dir, sub);
      return fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : '';
    });
  };
  const modalsCss = readCssWithImports('ui/assets/styles/40-modals.css');
  const edgeGuard = /\.model-panel\s*>\s*\.provider-editor-op-result\s*\{[^}]*margin:[^;}]*16px/.test(modalsCss);
  ok('面板内嵌状态条贴边已拦截（.model-panel > .provider-editor-op-result 需 16px 水平 margin）', edgeGuard,
    'ui/assets/styles/40-modals.css（及其导入模块）缺少 .model-panel > .provider-editor-op-result 的水平 margin 规则，状态条会贴面板边框');
}

// ─────────────────────────────────────────────────────────────
// [3.9] 新增文件行数守卫：只拦新增，存量豁免（防巨型文件持续入场）
// ─────────────────────────────────────────────────────────────
section('服务商模板库完整性（预设数据 + 图标一致性）');
runProviderPresetChecks(ctx);

section('代码文件体积与结构守卫（禁止 >800 行巨型文件与无语义 part-NN 分片）');
runCodebaseStructureChecks(ctx);
}

// ─────────────────────────────────────────────────────────────
// [4] 本机环境实况（已启用汉化的客户端必须链路完整）
// ─────────────────────────────────────────────────────────────
if (runLive) {
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

  // 语言包生效链（真相判据：语言包插件真实提供核心翻译；官方包或功能完整的第三方中文包都算）
  // 汉化两层：①语言包插件（核心 UI，本段）②workbench 注入（专有 UI，上面已查）
  const extDir = path.join(home, `.${name.toLowerCase()}`, 'extensions');
  const ver = engineVersion(installRoot);
  if (!ver) { ok(`${name} 引擎版本可读`, false); return; }
  const want = ver.split('.').slice(0, 2).join('.');

  // AnyBridge 自动安装的官方包（兜底）：存在与否只作提示——用户可能已用第三方中文包
  const packDir = fs.existsSync(extDir)
    ? fs.readdirSync(extDir).find(d => {
        if (!d.startsWith(PACK_ID)) return false;
        // 目录名形如 `ms-ceintl...-1.126.0`：去掉前导 `-` 再解析版本
        const verStr = d.slice(PACK_ID.length).replace(/^-/, '');
        const parts = verStr.split('.').filter(x => /^\d+$/.test(x)).slice(0, 2).join('.');
        return parts === want;
      })
    : null;
  if (!packDir) {
    warn(`${name} 官方语言包目录缺失（当前生效的可能是第三方中文包，不影响汉化）`);
  }

  const obsPath = path.join(extDir, '.obsolete');
  let obsoleteKeys = [];
  try {
    obsoleteKeys = Object.keys(JSON.parse(fs.readFileSync(obsPath, 'utf8'))).map(k => k.toLowerCase());
  } catch {}

  const lpPath = path.join(process.env.APPDATA || '', appDataDir, 'languagepacks.json');
  let zh = {};
  try {
    zh = JSON.parse(fs.readFileSync(lpPath, 'utf8'))['zh-cn'] || {};
  } catch {}

  // 条件 1：核心翻译文件存在（能翻核心 UI 的硬证据，官方包与完整第三方包都满足）
  const coreTr = zh.translations?.vscode;
  ok(`${name} 语言包插件提供核心翻译（translations.vscode 存在）`,
    !!(coreTr && fs.existsSync(coreTr)),
    coreTr ? `文件缺失: ${coreTr}` : 'zh-cn.translations.vscode 缺失');

  // 条件 2：至少一个注册的扩展真实加载（目录存在 + 未被 .obsolete 废弃）
  const extNames = fs.existsSync(extDir) ? fs.readdirSync(extDir).map(d => d.toLowerCase()) : [];
  const regIds = (zh.extensions || []).map(e => e.extensionIdentifier?.id).filter(Boolean);
  const anyActive = regIds.some(id => {
    const idl = id.toLowerCase();
    if (obsoleteKeys.some(k => k.startsWith(idl))) return false;
    return extNames.some(n => n === idl || n.startsWith(idl + '-'));
  });
  ok(`${name} 语言包插件已注册且目录存在、未被废弃`, anyActive,
    anyActive ? '' : `注册项: ${JSON.stringify(regIds)}`);

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
}

if (runFast) {
  section('Sidecar ESM 导入导出完整性');
  {
    const sidecarDir = path.join(root, 'sidecar');
    const jsFiles = [];
    const walkJs = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (e.name === 'node_modules' || e.name === 'build' || e.name.startsWith('.')) continue;
        const p = path.join(d, e.name);
        if (e.isDirectory()) walkJs(p);
        else if (e.name.endsWith('.js')) jsFiles.push(p);
      }
    };
    walkJs(sidecarDir);
    const stripComments = (s) =>
      s.replace(/\r\n/g, '\n').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const getExports = (src) => {
      const cleaned = stripComments(src);
      const names = new Set();
      const reexportAll = [];
      for (const m of cleaned.matchAll(/^\s*export\s+(?:async\s+)?(?:function\*?|class|const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)/gm)) {
        names.add(m[1]);
      }
      for (const m of cleaned.matchAll(/^\s*export\s*\{([^}]*)\}(?:\s*from\s*['"]([^'"]+)['"])?/gm)) {
        for (const part of m[1].split(',')) {
          const s = part.trim();
          if (!s) continue;
          const asMatch = s.match(/^([A-Za-z_$][A-Za-z0-9_$]*)\s+as\s+([A-Za-z_$][A-Za-z0-9_$]*)$/);
          names.add(asMatch ? asMatch[2] : s.split(/\s+/)[0]);
        }
      }
      for (const m of cleaned.matchAll(/^\s*export\s+\*\s+(?:as\s+([A-Za-z_$][A-Za-z0-9_$]*)\s+)?from\s+['"]([^'"]+)['"]/gm)) {
        if (m[1]) names.add(m[1]);
        else reexportAll.push(m[2]);
      }
      if (/^\s*export\s+default\b/m.test(cleaned)) names.add('default');
      return { names, reexportAll };
    };
    const exportCache = new Map();
    const resolveExports = (fileAbs, seen = new Set()) => {
      const key = path.resolve(fileAbs);
      if (seen.has(key)) return new Set();
      const nextSeen = new Set(seen);
      nextSeen.add(key);
      if (exportCache.has(key)) return exportCache.get(key);
      const { names, reexportAll } = getExports(fs.readFileSync(key, 'utf8'));
      const all = new Set(names);
      for (const spec of reexportAll) {
        if (spec.startsWith('.')) {
          const target = path.resolve(path.dirname(key), spec);
          if (fs.existsSync(target) && fs.statSync(target).isFile()) {
            for (const n of resolveExports(target, nextSeen)) all.add(n);
          }
        }
      }
      exportCache.set(key, all);
      return all;
    };
    const errs = [];
    let checked = 0;
    for (const f of jsFiles) {
      const relF = path.relative(root, f).replace(/\\/g, '/');
      const cleaned = stripComments(fs.readFileSync(f, 'utf8'));
      for (const m of cleaned.matchAll(/(?:^|\n)\s*import\s+([^;'"]+?)\s+from\s+['"](\.[^'"]+)['"]/g)) {
        const clause = m[1].trim(), spec = m[2];
        const target = path.resolve(path.dirname(f), spec);
        checked++;
        if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
          errs.push(`${relF}: 缺失导入目标 ${spec}`);
          continue;
        }
        const exported = resolveExports(target);
        const braceMatch = clause.match(/\{([\s\S]*?)\}/);
        if (braceMatch) {
          for (const item of braceMatch[1].split(',')) {
            const t = item.trim();
            if (!t) continue;
            const orig = t.split(/\s+as\s+/)[0].trim();
            if (!exported.has(orig)) errs.push(`${relF}: ${spec} 未导出 '${orig}'`);
          }
        }
        const beforeBrace = clause.replace(/\{[\s\S]*\}/, '').replace(/,/g, '').trim();
        if (beforeBrace && !beforeBrace.startsWith('*') && !exported.has('default')) {
          errs.push(`${relF}: ${spec} 未默认导出 '${beforeBrace}'`);
        }
      }
      for (const m of cleaned.matchAll(/(?:^|\n)\s*import\s+['"](\.[^'"]+)['"]/g)) {
        const spec = m[1];
        const target = path.resolve(path.dirname(f), spec);
        checked++;
        if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
          errs.push(`${relF}: 缺失副作用导入目标 ${spec}`);
        }
      }
      for (const m of cleaned.matchAll(/^\s*export\s*(?:\*|\{([^}]*)\})\s*from\s*['"](\.[^'"]+)['"]/gm)) {
        const namesBlock = m[1], spec = m[2];
        const target = path.resolve(path.dirname(f), spec);
        checked++;
        if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
          errs.push(`${relF}: 缺失再导出目标 ${spec}`);
          continue;
        }
        if (namesBlock !== undefined) {
          const exported = resolveExports(target);
          for (const item of namesBlock.split(',')) {
            const t = item.trim();
            if (!t) continue;
            const orig = t.split(/\s+as\s+/)[0].trim();
            if (!exported.has(orig)) errs.push(`${relF}: ${spec} 未导出再导出项 '${orig}'`);
          }
        }
      }
    }
    ok(`sidecar ${checked} 处相对导入/再导出符号均存在`, errs.length === 0, errs.slice(0, 8).join('; '));
  }
}

// ─────────────────────────────────────────────────────────────
// 汇总
// ─────────────────────────────────────────────────────────────
console.log(`\n════════════════════════════════════`);
console.log(`通过 ${passed} ｜ 失败 ${failed} ｜ 提示 ${warned}`);
console.log(failed === 0 ? '✅ 全部通过' : '❌ 存在失败项——必须修复后重跑，任务不得结束');
process.exit(failed === 0 ? 0 : 1);
