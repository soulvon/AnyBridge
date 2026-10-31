#!/usr/bin/env node
/**
 * 防泄漏门控 —— 内部资料不得进入公开仓库
 *
 *   node scripts/check-no-leak.mjs          全量（本地收工 / 发布前）
 *   node scripts/check-no-leak.mjs --fast   提交前（暂存区 + 仓库内物理检查）
 *
 * 背景：AnyBridge 是公开仓库。docs/ 下的开发流水账、逆向调研、营销草稿
 * 一旦推上去就无法干净撤回 —— git 历史不可逆，filter-repo 会打乱所有
 * fork 与 clone。因此这些资料物理隔离在仓库之外的本地资料目录，
 * 本脚本逐层校验隔离是否仍然成立。
 *
 * 五道闸：
 *   [A] 仓库内不得出现内部资料路径（物理隔离是否被破坏）
 *   [B] 已跟踪文件不得命中内部路径黑名单
 *   [C] 已跟踪文本不得含本机绝对路径（防止 AGENTS.md 被工具重新注入）
 *   [D] 暂存区新增文件不得命中黑名单（pre-commit 即拦）
 *   [E] 远端分支已公开的黑名单路径（仅告警 —— 历史层无法回收）
 *
 * 退出码：0 = 通过；1 = 有失败（必须修复后重跑）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fast = process.argv.includes('--fast');
const SELF = 'scripts/check-no-leak.mjs';
let passed = 0;
let failed = 0;
let warned = 0;

function ok(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`); }
}
function warn(name, detail = '') {
  warned++;
  console.log(`  ⚠ 提示 ${name}${detail ? ' — ' + detail : ''}`);
}
function section(name) { console.log(`\n■ ${name}`); }

function git(cmd) {
  try {
    return execSync(`git ${cmd}`, { cwd: root, encoding: 'utf8', stdio: 'pipe' });
  } catch { return ''; }
}
function lines(text) { return text.split('\n').filter(Boolean); }

// ─────────────────────────────────────────────────────────────
// 内部资料清单 —— 唯一真源。新增内部产物时只改这里。
// 每条：[仓库内路径或前缀, 人话说明]
// ─────────────────────────────────────────────────────────────
const INTERNAL_PATHS = [
  ['docs/experience/', '逐次修复流水账'],
  ['docs/tasks/', '单功能任务分解与证据链'],
  ['docs/superpowers/', '开发流程技能草稿'],
  ['docs/claude-code-unlock-research/', '解锁调研与嗅探日志'],
  ['docs/claude-code-unlock-research.md', '解锁调研'],
  ['docs/cursor-backend-api.md', 'Cursor 私有接口逆向'],
  ['docs/cursor-backend-api_en.md', 'Cursor 私有接口逆向'],
  ['spec/', '设计/调研文档（不宜公开的过程产物）'],
  ['cursor byok调研/', 'Cursor BYOK 调研资料'],
  ['宣传.md', '发布渠道推广文案'],
  ['待办.md', '产品路线待办'],
  ['devloop.project.json', '本机 AI 工具链绑定'],
  // 凭据与账号池：泄露即事故，一律放仓库之外的本地资料目录
  ['sub2api_alive100.json', '账号池凭据导出（含 credentials 字段）'],
  ['cpa_alive100/', '账号池明细（文件名即邮箱地址）'],
  ['cpa_alive100.zip', '账号池打包'],
  // 本机抓包与运行日志：绑定本机路径，且抓包产物含账号流量
  ['qoder-watch.cjs', '抓包定位脚本（按 pid 采样外连）'],
  ['qoder-sniff.cjs', '抓包嗅探脚本'],
  ['dev-tauri.err', 'Tauri 运行日志（含本机绝对路径）'],
  ['.local-archive/', '历史归档（问题追踪、旧日志、图标备份）'],
  // 第三位 true = 允许文件留在磁盘（本机 AI 工具要读），只禁止进入版本库
  ['AGENTS.md', 'AI 操作手册（含注入实现约束与事故细节）', true],
];

// docs/ 下按文件名关键词兜底 —— 命不中上面的具体路径也不会漏
const INTERNAL_PATTERNS = [
  [/^docs\/.*research.*\.md$/i, 'docs 下的调研文档'],
  [/^docs\/.*-api(_en)?\.md$/i, 'docs 下的接口逆向文档'],
  [/^docs\/.*(设计|调研|方案|规划|总结|分析).*\.md$/, 'docs 下的过程文档'],
  // 根目录账号池导出（名字带 alive 的 json/zip 基本都是这个性质）
  [/^[^/]*alive\d*\.(json|zip)$/i, '账号池导出'],
  // Qoder 抓包工具与其日志
  [/^qoder-.*\.(cjs|js|log)$/i, 'Qoder 抓包工具'],
];

// 本机绝对路径：盘符 + 已知本机目录。命中说明内容绑定某一台机器，
// 对其他人无意义，且暴露本机目录习惯（工具自动注入的经验库指针就是这样漏的）。
const LOCAL_PATH_RE = /[A-Za-z]:[\\/](?:Users|Ailoop|project|情报|内容生产|SCRAG)(?:[\\/]|$)/;

// 合法例外：单元测试 fixture 与文档占位符用的是假身份，不含真实用户名/项目名。
// 只放行到目录段为止，出现真实名字仍会命中上面那条。
const LOCAL_PATH_ALLOW = [
  /[A-Za-z]:[\\/]Users[\\/]test(?![\w-])/i,
  /[A-Za-z]:[\\/]Users[\\/]Test User(?![\w-])/i,
  /[A-Za-z]:[\\/]Users[\\/]<user>(?![\w-])/i,
  /[A-Za-z]:[\\/]project[\\/]demo(?![\w-])/i,
];

// 逐行判断：同一文件里可能既有假 fixture 又有真路径，整文件粒度会漏。
function realLocalPathLines(text) {
  const bad = [];
  text.split('\n').forEach((line, i) => {
    if (LOCAL_PATH_RE.test(line) && !LOCAL_PATH_ALLOW.some(re => re.test(line))) bad.push(i + 1);
  });
  return bad;
}

function matchInternal(file) {
  const norm = file.replace(/\\/g, '/').replace(/^"|"$/g, '');
  for (const [prefix, label] of INTERNAL_PATHS) {
    if (prefix.endsWith('/') ? norm.startsWith(prefix) : norm === prefix) return label;
  }
  for (const [re, label] of INTERNAL_PATTERNS) {
    if (re.test(norm)) return label;
  }
  return null;
}

// 隔离区真实路径不写死在源码里（源码本身是公开的）。
// 本机想看到确切位置就设 ANYBRIDGE_LOCAL_DIR，未设时只打印中性说明。
const LOCAL_DIR_HINT = process.env.ANYBRIDGE_LOCAL_DIR || '仓库之外的本地资料目录';

// 隔离目录名仅供门控自检，用拼接构造，避免本文件自己命中检测规则。
// 必须带路径分隔符才算命中：anybridge-local 本身是产品术语
// （Multi2API 的固定密钥值、anybridge-local-proxy 供应商 ID），不是目录。
const LOCAL_DIR_NAME_RE = new RegExp(['AnyBridge', 'local'].join('-') + '[\\\\/]', 'i');

console.log('🔒 防泄漏门控：内部资料不得进入公开仓库');
console.log(`   本地隔离区：${LOCAL_DIR_HINT}`);

// ─────────────────────────────────────────────────────────────
// [A] 仓库内不得出现内部资料路径
//     文件级检查，防止「本地笔记又手滑写回仓库」这一最常见入口。
// ─────────────────────────────────────────────────────────────
section('物理隔离（内部资料不在仓库内）');
{
  // 第三位为 true 的项（如 AGENTS.md）允许留在磁盘，只由 [B]/[D] 拦入库
  const present = INTERNAL_PATHS.filter(([p, , keepLocal]) => !keepLocal && fs.existsSync(path.join(root, p)));
  ok('仓库内无内部资料目录', present.length === 0,
    present.map(([p, l]) => `${p}(${l})`).join(', ') + (present.length ? ' → 迁到仓库之外的本地资料目录' : ''));
}

// ─────────────────────────────────────────────────────────────
// [B] 已跟踪文件不得命中黑名单
//     gitignore 对已跟踪文件无效（经典陷阱），必须显式核对索引。
// ─────────────────────────────────────────────────────────────
section('索引层（已跟踪文件）');
const tracked = lines(git('ls-files'));
ok('已跟踪文件总数可读', tracked.length > 0, 'git ls-files 返回空');
{
  const bad = tracked.map(f => [f, matchInternal(f)]).filter(([, l]) => l);
  ok('已跟踪文件无内部资料', bad.length === 0,
    bad.slice(0, 5).map(([f, l]) => `${f}(${l})`).join(', ') +
    (bad.length > 5 ? ` …共 ${bad.length} 个 → git rm --cached` : ''));
}

// ─────────────────────────────────────────────────────────────
// [C] 已跟踪文本不得含本机绝对路径
//     工具会往约定文件里注入本机指针，而 gitignore 对已跟踪文件无效，
//     只能在内容层兜住。
// ─────────────────────────────────────────────────────────────
section('内容层（本机绝对路径）');
{
  const scanRe = /\.(md|json|html|txt|mjs|cjs|rs|toml)$/i;
  const hits = [];
  const named = [];
  for (const f of tracked) {
    if (!scanRe.test(f) || f === SELF) continue;
    let text = '';
    try { text = fs.readFileSync(path.join(root, f), 'utf8'); } catch { continue; }
    const bad = realLocalPathLines(text);
    if (bad.length) hits.push(`${f}:${bad[0]}`);
    // 隔离目录名本身也不该出现：等于对外宣告「隔壁放着内部资料」
    if (LOCAL_DIR_NAME_RE.test(text)) named.push(f);
  }
  ok('已跟踪文本无本机绝对路径', hits.length === 0,
    hits.slice(0, 5).join(', ') + (hits.length > 5 ? ` …共 ${hits.length} 个` : '') +
    (hits.length ? ' → 删除本机路径或把该文件移出仓库' : ''));
  ok('已跟踪文本未提及本地资料目录', named.length === 0,
    named.join(', ') + (named.length ? ' → 改成中性表述' : ''));
}

// ─────────────────────────────────────────────────────────────
// [D] 暂存区新增文件不得命中黑名单（pre-commit 现场拦截）
// ─────────────────────────────────────────────────────────────
section('暂存区（本次提交）');
{
  const added = lines(git('diff --cached --name-only --diff-filter=AM'));
  const badInternal = added.map(f => [f, matchInternal(f)]).filter(([, l]) => l);
  ok('暂存区无新增内部资料', badInternal.length === 0,
    badInternal.map(([f, l]) => `${f}(${l})`).join(', '));

  // 暂存区里的本机路径/隔离目录名同样要拦（只看新增内容，避免历史文件反复报）
  const leaked = [];
  const leakedNames = [];
  for (const f of added) {
    if (!/\.(md|json|html|mjs|cjs|rs|toml)$/i.test(f) || f === SELF) continue;
    let text = '';
    try { text = git(`show :${JSON.stringify(f)}`); } catch { continue; }
    const badLines = realLocalPathLines(text);
    if (badLines.length) leaked.push(`${f}:${badLines[0]}`);
    if (LOCAL_DIR_NAME_RE.test(text)) leakedNames.push(f);
  }
  ok('暂存内容无本机绝对路径', leaked.length === 0, leaked.join(', '));
  ok('暂存内容未提及本地资料目录', leakedNames.length === 0, leakedNames.join(', '));
}

// ─────────────────────────────────────────────────────────────
// [E] 远端已公开清单 —— 只告警，不阻断
//     历史层无法回收，如实记录即可；目的是让「已经漏了哪些」始终可见，
//     而不是让人以为仓库是干净的。
// ─────────────────────────────────────────────────────────────
if (!fast) {
  section('远端层（历史遗留，仅告警）');
  const hasRemote = git('rev-parse --verify origin/main').trim() !== '';
  if (!hasRemote) {
    console.log('  ℹ 无 origin/main 引用（干净检出或 CI），跳过远端核对');
  } else {
    const remoteFiles = lines(git('ls-tree -r --name-only origin/main'));
    const exposed = remoteFiles.filter(f => matchInternal(f));
    if (exposed.length === 0) {
      passed++; console.log('  ✅ 远端 main 无内部资料');
    } else {
      // 按类别汇总，避免把几十个中文长文件名铺满终端
      const byLabel = {};
      for (const f of exposed) {
        const label = matchInternal(f) || '其他';
        byLabel[label] = (byLabel[label] || 0) + 1;
      }
      const summary = Object.entries(byLabel).map(([k, v]) => `${k} ${v} 个`).join('、');
      warn(`远端 main 已公开 ${exposed.length} 个内部文件`,
        `${summary}（历史不可回收，仅记录；工作区已隔离）`);
    }
  }
}

console.log('\n════════════════════════════════════');
console.log(`通过 ${passed} ｜ 失败 ${failed} ｜ 提示 ${warned}`);
if (failed > 0) {
  console.log('❌ 防泄漏门控未通过：内部资料不得进入公开仓库。');
  console.log('   处置：迁到仓库之外的本地资料目录；已跟踪的用 git rm --cached 移出索引。');
  process.exit(1);
}
console.log('✅ 防泄漏门控通过');
