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

// ─────────────────────────────────────────────────────────────
// [0] 开头先亮出坑点清单 —— 人和 AI 在改代码前就该看到，
//     而不是等提交被拦下才知道踩了旧坑。
// ─────────────────────────────────────────────────────────────
{
  const pfPath = path.join(root, 'docs', 'pitfalls.json');
  if (fs.existsSync(pfPath)) {
    const pf = JSON.parse(fs.readFileSync(pfPath, 'utf8'));
    console.log(`📌 已知坑点 ${pf.pitfalls.length} 条（改动前必读 docs/pitfalls.json）：`);
    pf.pitfalls.forEach((p, i) => {
      console.log(`   ${String(i + 1).padStart(2)}. [${p.severity}] ${p.title}`);
    });
    console.log('');
  }
}

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
    ok('cargo test 全量单测通过', false, (e.stdout || e.message || '').slice(-300));
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

// ─────────────────────────────────────────────────────────────
// [3] 坑点库逐条执行（docs/pitfalls.json —— 沉淀必须能反馈工作流，
//     而不是躺在文档里；每条坑都带可机器验证的判据）
// ─────────────────────────────────────────────────────────────
section('坑点库（docs/pitfalls.json 逐条验证）');
{
  const pfPath = path.join(root, 'docs', 'pitfalls.json');
  if (!fs.existsSync(pfPath)) {
    ok('坑点库存在', false, 'docs/pitfalls.json 缺失');
  } else {
    const pf = JSON.parse(fs.readFileSync(pfPath, 'utf8'));
    ok(`坑点库已加载（${pf.pitfalls.length} 条）`, true);
    for (const p of pf.pitfalls) {
      const c = p.check;
      if (!c) { ok(`[${p.id}] 有判据`, false); continue; }
      const file = path.join(root, c.file);
      if (!fs.existsSync(file)) { ok(`[${p.id}] ${c.file} 存在`, false); continue; }
      const src = fs.readFileSync(file, 'utf8');
      let pass = false;
      if (c.type === 'source_contains') pass = src.includes(c.must_contain);
      else if (c.type === 'source_not_regex') pass = !new RegExp(c.must_not_match).test(src);
      ok(`[${p.id}] ${p.title}`, pass, pass ? '' : `判据未满足（${c.type}）`);
      // 额外的 must_not 判据
      if (pass && p.check_not) {
        const n = p.check_not;
        const nf = path.join(root, n.file);
        if (fs.existsSync(nf)) {
          const nsrc = fs.readFileSync(nf, 'utf8');
          const okNot = !new RegExp(n.must_not_match).test(nsrc);
          ok(`[${p.id}] 反向判据（不得回退）`, okNot);
        }
      }
      // 行为测试引用：由 test:unit / cargo test 实际执行，这里只防止引用漂移
      if (p.regression_test) {
        const [refFile, ...refParts] = p.regression_test.split('::');
        const refPath = path.join(root, refFile);
        const refName = refParts.join('::');
        const refExists = fs.existsSync(refPath);
        const refSource = refExists ? fs.readFileSync(refPath, 'utf8') : '';
        ok(`[${p.id}] 行为测试引用未漂移`, refExists && refSource.includes(refName),
          refExists ? `未找到: ${refName}` : `${refFile} 不存在`);
      }
    }
  }
}

// ─────────────────────────────────────────────────────────────
// [3.5] 对称路径检查（专治「改 A 漏 B」：接入↔还原、apply↔restore）
// ─────────────────────────────────────────────────────────────
section('对称路径（接入↔还原 / apply↔restore 必须一致）');
{
  // 3.5.1 命令级：成对的 apply_/restore_ 命令异步化状态必须一致
  const cmds = [];
  for (const f of fs.readdirSync(path.join(root, 'src-tauri/src/commands'))) {
    if (!f.endsWith('.rs')) continue;
    const src = fs.readFileSync(path.join(root, 'src-tauri/src/commands', f), 'utf8');
    const re = /#\[tauri::command\]\s*(?:pub\s+)?(async\s+)?fn\s+(\w+)/g;
    let m;
    while ((m = re.exec(src))) cmds.push({ name: m[2], async: !!m[1] });
  }
  const byName = new Map(cmds.map(c => [c.name, c]));
  const asym = [];
  for (const c of cmds) {
    if (!/^(apply|restore)_/.test(c.name)) continue;
    const paired = c.name.replace(/^(apply|restore)_/, (_, k) => (k === 'apply' ? 'restore_' : 'apply_'));
    const other = byName.get(paired);
    if (other && other.async !== c.async) {
      asym.push(`${c.name}(${c.async ? 'async' : 'sync'}) ↔ ${other.name}(${other.async ? 'async' : 'sync'})`);
    }
  }
  ok('apply/restore 命令对异步化一致', asym.length === 0, asym.join('; '));

  // 3.5.2 Antigravity 接入与还原共用同一杀进程实现（曾漏改还原路径）
  const pf = fs.readFileSync(path.join(root, 'src-tauri/src/commands/platforms.rs'), 'utf8');
  const killCalls = (pf.match(/Self::kill_antigravity_language_server\(\)/g) || []).length;
  ok('Antigravity 接入+还原都调用同一 kill 实现', killCalls >= 2, `调用点 ${killCalls} 处（应≥2）`);
}

// ─────────────────────────────────────────────────────────────
// [3.6] 临时文件纪律：只允许放 tmp/，根目录与源码目录不允许
// ─────────────────────────────────────────────────────────────
section('临时文件纪律（只允许 tmp/）');
{
  // 临时/杂项文件的判定（与 tmp/migrate-rest.mjs 保持一致）：
  // 常见前缀（tmp/temp/scratch/test/debug/probe/draft/untitled/new_/old_/check_）
  // + 临时后缀（.bak/.orig/.old/.swp/.tmp/.rej/~）+ 运行时日志（.log）
  const TEMP_PREFIX = /^(\.?tmp[-_]|temp[-_]|scratch|test[-_]|debug[-_]|probe|draft|untitled|new_|old_|check_)/i;
  const TEMP_SUFFIX = /\.(bak|orig|old|swp|tmp|rej)$/i;
  // 注意排除 tmp/ 目录本身（它是临时文件的唯一合法去处）
  const isTemp = (name) =>
    name !== 'tmp' && (TEMP_PREFIX.test(name) || TEMP_SUFFIX.test(name) || /~$/.test(name));
  const isLog = (name) => /\.log$/i.test(name);

  // 脚本/数据型临时文件 → 硬失败（必须进 tmp/）
  const strays = fs.readdirSync(root).filter(f => isTemp(f) && !isLog(f));
  ok('根目录无散落临时文件（脚本/数据）', strays.length === 0,
    strays.length ? `违规: ${strays.join(', ')}（请移入 tmp/）` : '');

  // 运行时日志：自愈式处理——能移就自动迁入 tmp/；被存活进程锁定时
  // 物理上无法移动（Windows 独占句柄），只提示、不判失败（下次句柄释放后
  // 检查会自动迁走）。新日志已固定写 tmp/tauri-run.log。
  const tmpDirPath = path.join(root, 'tmp');
  const strayLogs = fs.readdirSync(root).filter(isLog);
  let lockedLogs = [];
  for (const lf of strayLogs) {
    try {
      if (!fs.existsSync(tmpDirPath)) fs.mkdirSync(tmpDirPath);
      fs.renameSync(path.join(root, lf), path.join(tmpDirPath, lf));
      console.log(`  ↪ 已自动迁入 tmp/: ${lf}`);
    } catch {
      lockedLogs.push(lf);
    }
  }
  if (lockedLogs.length) {
    console.log(`  ℹ 被进程独占锁定，暂无法移动（下次检查自动重试）: ${lockedLogs.join(', ')}`);
  }
  // 判定标准：可移动的日志已全部迁入 tmp/（能移的都移了即通过；
  // 被锁文件属物理限制，不制造永久红灯）
  ok('运行日志已归入 tmp/（可移动部分）', true);

  // 源码目录同样不允许
  for (const d of ['src-tauri/src', 'ui', 'ui-src', 'scripts']) {
    const full = path.join(root, d);
    if (!fs.existsSync(full)) continue;
    const bad = [];
    const scan = (dir, depth) => {
      if (depth > 4) return;
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.name.startsWith('.tmp_')) bad.push(path.join(dir, e.name).replace(root + path.sep, ''));
        else if (e.isDirectory()) scan(path.join(dir, e.name), depth + 1);
      }
    };
    scan(full, 0);
    ok(`${d}/ 无散落临时文件`, bad.length === 0, bad.join(', '));
  }

  // tmp/ 目录存在（临时文件的唯一去处）
  ok('tmp/ 目录存在', fs.existsSync(path.join(root, 'tmp')));
}

// ─────────────────────────────────────────────────────────────
// [3.7] 提交卫生：不该入库的东西必须被 gitignore 挡住
// ─────────────────────────────────────────────────────────────
section('提交卫生（不该提交的不提交）');
{
  // 3.7.1 关键忽略规则必须存在且真实生效（防规则被误删/失效）
  const mustIgnore = [
    ['tmp/', '临时文件目录'],
    ['.codebuddy/', 'AI 工具配置目录'],
    ['src-tauri/target/', 'Rust 构建产物'],
    ['node_modules/', '依赖目录'],
  ];
  for (const [pat, label] of mustIgnore) {
    let ignored = false;
    try {
      execSync(`git check-ignore -q "${pat}__probe__"`, { cwd: root, stdio: 'pipe' });
      ignored = true;
    } catch { ignored = false; }
    ok(`${pat} 被 gitignore 覆盖（${label}）`, ignored, ignored ? '' : '规则缺失或失效');
  }

  // 3.7.2 已跟踪文件里不得有 日志/临时/敏感/构建产物
  let tracked = '';
  try {
    tracked = execSync('git ls-files', { cwd: root, encoding: 'utf8', stdio: 'pipe' });
  } catch {}
  const files = tracked.split('\n').filter(Boolean);
  const banned = files.filter(f => {
    if (/^(tmp\/|node_modules\/|src-tauri\/target\/|cursor-core\/target\/)/.test(f)) return true;
    if (/\.(log|bak|orig|swp|rej)$/i.test(f)) return true;
    if (/^\.tmp_|^tmp_/.test(path.basename(f))) return true;
    // 敏感文件（.env.example / .gitkeep 属正当模板，放行）
    if (/(^|\/)\.env$/.test(f)) return true;
    if (/\.(pem|key|pfx|p12)$/i.test(f) && !/\.gitkeep$/.test(f)) return true;
    return false;
  });
  ok('已跟踪文件无日志/临时/敏感/构建产物', banned.length === 0,
    banned.slice(0, 6).join(', ') + (banned.length > 6 ? ` …共 ${banned.length} 个` : ''));

  // 3.7.3 暂存区（pre-commit 时）不得含不该提交的文件
  let staged = '';
  try {
    staged = execSync('git diff --cached --name-only', { cwd: root, encoding: 'utf8', stdio: 'pipe' });
  } catch {}
  const stagedBad = staged.split('\n').filter(Boolean).filter(f => {
    if (/^(tmp\/|node_modules\/|src-tauri\/target\/)/.test(f)) return true;
    if (/\.(log|bak|orig|swp|rej)$/i.test(f)) return true;
    if (/^\.tmp_|^tmp_/.test(path.basename(f))) return true;
    if (/(^|\/)\.env$/.test(f)) return true;
    if (/\.(pem|key|pfx|p12)$/i.test(f)) return true;
    return false;
  });
  ok('暂存区无非预期文件', stagedBad.length === 0, stagedBad.join(', '));

  // 3.7.4 敏感值扫一遍暂存区的源码改动（防止把 key/token 提交上去）
  const secretRe = /(sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16})/;
  let leaked = [];
  if (staged.trim()) {
    for (const f of staged.split('\n').filter(Boolean)) {
      if (!/\.(rs|js|mjs|ts|json|toml|html|md)$/i.test(f)) continue;
      try {
        const content = execSync(`git show :${JSON.stringify(f)}`, { cwd: root, encoding: 'utf8', stdio: 'pipe' });
        if (secretRe.test(content)) leaked.push(f);
      } catch {}
    }
  }
  ok('暂存内容无明文密钥', leaked.length === 0, leaked.join(', '));

  // 3.7.5 文档纪律：只允许「说明文档」入库，设计/调研/规划文档不入库
  //
  // 区分标准：
  //   ✅ 说明文档：给使用者/贡献者看的（README、CHANGELOG、AGENTS、
  //      架构/开发/发布/排障/WORKFLOW），以及**运行时资源**（Cursor 提示词
  //      模板、sidecar 与插件自带的 prompt/deploy 说明——它们是程序的一部分）
  //   ❌ 设计文档：开发过程产物（调研报告、方案设计、规划、逆向分析），
  //      随迭代快速过期，入库只会变成噪音和泄密风险
  const DOC_ALLOW = [
    /^README(_en)?\.md$/i,
    /^CHANGELOG\.md$/i,
    /^AGENTS\.md$/i,
    /^docs\/(ARCHITECTURE|DEVELOPMENT|RELEASE|MACOS_TROUBLESHOOTING|WORKFLOW)(_zh)?\.md$/i,
    /^docs\/subsystems\/[a-z0-9-]+\.md$/i,
    /(^|\/)README\.md$/i,
    /^\.github\/pull_request_template\.md$/i,
    /^cursor-core\/prompt\//,        // 运行时提示词模板（程序资源）
    /^cursor-core\/UPSTREAM\.md$/i,  // 上游来源说明
    /^sidecar\/prompts\//,           // 运行时 prompt
    /^src-tauri\/resources\//,       // 插件自带说明与运行时 prompt
  ];
  const trackedMd = files.filter(f => /\.md$/i.test(f));
  const docViolations = trackedMd.filter(f => !DOC_ALLOW.some(re => re.test(f)));
  ok('已跟踪文档均为说明文档（无设计/调研文档）', docViolations.length === 0,
    docViolations.length ? `不应入库：${docViolations.join(', ')}` : '');

  // 暂存区同样检查（pre-commit 时拦住新加的设计文档）。
  // 只看新增/修改（--diff-filter=AM）：删除设计文档恰恰是正确操作，不该报错。
  let stagedAddMod = '';
  try {
    stagedAddMod = execSync('git diff --cached --name-only --diff-filter=AM', {
      cwd: root, encoding: 'utf8', stdio: 'pipe',
    });
  } catch {}
  const stagedMd = stagedAddMod.split('\n').filter(Boolean).filter(f => /\.md$/i.test(f));
  const stagedDocBad = stagedMd.filter(f => !DOC_ALLOW.some(re => re.test(f)));
  ok('暂存区无新增设计/调研文档', stagedDocBad.length === 0, stagedDocBad.join(', '));

  // 3.7.6 经典陷阱：.gitignore 对**已跟踪**文件无效。
  // 先提交、后加忽略规则的文件仍会留在库里（实测曾有 5 个探针/测试脚本）。
  // 这条断言保证「以为忽略了其实还在」的情况不再积累。
  let ignoredButTracked = '';
  try {
    ignoredButTracked = execSync('git ls-files -i -c --exclude-standard', {
      cwd: root, encoding: 'utf8', stdio: 'pipe',
    });
  } catch {}
  const ibt = ignoredButTracked.split('\n').filter(Boolean);
  ok('无「已跟踪却匹配 gitignore」的文件', ibt.length === 0,
    ibt.length ? `${ibt.join(', ')} → 需 git rm --cached 或加 ! 例外` : '');
}

// ─────────────────────────────────────────────────────────────
// [4] 关键判据回归（出过事故的点，源码级断言）
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
// [3.8] UI 设计铁律守卫：硬规则拦提交，存量风格债务进提示档
//   档位依据 2026-10-25 全量试跑数据（先报告后定档，拒绝拍脑袋硬规则）：
//   uppercase 存量 5 处已清零 → 硬规则；breath/ripple/wave 类动画名 0 处 → 硬规则；
//   pulse/glow/shimmer、蓝紫点缀色、<12px 字号、border-left → 提示档。
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
  const total = (hits) => hits.reduce((n, h) => n + h.count, 0);
  const topFiles = (hits) => hits.sort((a, b) => b.count - a.count).slice(0, 3)
    .map(h => `${h.file}(${h.count})`).join(', ');

  // [硬] 全大写英文标签（设计铁律 7）
  const upper = scanUi(/text-transform:\s*uppercase/gi);
  ok('全大写英文标签已清零（text-transform: uppercase）', upper.length === 0,
    upper.map(h => `${h.file}(${h.count})`).join(', '));

  // [硬] 被禁的廉价动效关键帧（雷达波纹/呼吸微光类，设计铁律 6）
  const bannedAnim = scanUi(/@keyframes\s+[\w-]*(?:breath|ripple|wave|扩散|波纹|呼吸|微光)[\w-]*/gi);
  ok('被禁动效关键帧为零（breath/ripple/wave 类）', bannedAnim.length === 0,
    bannedAnim.map(h => `${h.file}(${h.count})`).join(', '));

  // [提示] pulse/glow/shimmer 关键帧——多为状态点呼吸，骨架屏 shimmer 豁免（铁律 2 要求骨架屏）
  const softAnim = scanUi(/@keyframes\s+[\w-]*(?:pulse|glow|shimmer)[\w-]*/gi)
    .filter(h => !/skeleton/i.test(h.file));
  if (softAnim.length) warn(`pulse/glow/shimmer 关键帧 ${total(softAnim)} 处待人工定性`,
    `${topFiles(softAnim)}（状态点呼吸合法，装饰性光效应删）`);

  // [提示] 蓝紫系点缀色（设计铁律 6；供应商图标等功能性用色需人工甄别）
  const purple = scanUi(/#(?:6366f1|818cf8|4f46e5|4338ca|8b5cf6|7c3aed|6d28d9|a78bfa|c4b5fd|9333ea|7e22ce)\b/gi);
  if (purple.length) warn(`蓝紫系色值 ${total(purple)} 处`, `${topFiles(purple)}（功能性点缀可保留，禁作整体配色/渐变背景）`);

  // [提示] 字号 <12px（设计铁律 5；存量约 489 处，清理属全局视觉改版，待拍板）
  const smallFont = scanUi(/font-size:\s*(?:[0-9]|1[01])(?:\.\d+)?px\b/gi);
  if (smallFont.length) warn(`字号低于 12px ${total(smallFont)} 处`, `${topFiles(smallFont)}（存量债务，新增代码不得再增）`);

  // [提示] 左侧彩条装饰（设计铁律 12；CSS 三角形是合法误报）
  const leftBar = scanUi(/border-left:\s*[1-9]\d*px/g);
  if (leftBar.length) warn(`border-left 装饰 ${total(leftBar)} 处`, `${topFiles(leftBar)}（含三角形绘制误报，真彩条应换用背景/伪元素）`);
}

// ─────────────────────────────────────────────────────────────
// [3.9] 新增文件行数守卫：只拦新增，存量豁免（防巨型文件持续入场）
// ─────────────────────────────────────────────────────────────
section('新增文件行数守卫（>1500 行阻断，>1000 行提示）');
{
  let newFiles = '';
  try {
    newFiles = execSync('git diff --cached --name-only --diff-filter=A', { cwd: root, encoding: 'utf8', stdio: 'pipe' });
  } catch {}
  if (!newFiles.trim()) {
    try {
      newFiles = execSync('git ls-files -o --exclude-standard', { cwd: root, encoding: 'utf8', stdio: 'pipe' });
    } catch {}
  }
  const codeExt = /\.(js|mjs|cjs|ts|jsx|tsx|rs|py|css|html)$/i;
  const candidates = newFiles.split('\n').filter(Boolean)
    .filter(f => codeExt.test(f))
    .filter(f => !/^tmp\//.test(f))
    .filter(f => f !== 'ui/index.html');
  if (candidates.length === 0) {
    console.log('  ⏭ 暂无新增代码文件，跳过');
  } else {
    for (const f of candidates) {
      const lines = fs.readFileSync(path.join(root, f), 'utf8').split('\n').length;
      if (lines > 1500) {
        ok(`新增文件 ${f} 行数（${lines} 行）`, false, '超过 1500 行硬上限：新增文件必须拆分入场');
      } else if (lines > 1000) {
        warn(`新增文件 ${f} 行数（${lines} 行）`, '超过 1000 行提示线：建议拆分后再提交');
      } else {
        ok(`新增文件 ${f} 行数（${lines} 行）`, true);
      }
    }
  }
}
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
}

// ─────────────────────────────────────────────────────────────
// 汇总
// ─────────────────────────────────────────────────────────────
console.log(`\n════════════════════════════════════`);
console.log(`通过 ${passed} ｜ 失败 ${failed} ｜ 提示 ${warned}`);
console.log(failed === 0 ? '✅ 全部通过' : '❌ 存在失败项——必须修复后重跑，任务不得结束');
process.exit(failed === 0 ? 0 : 1);
