#!/usr/bin/env node
/**
 * 发版流程凭证 —— 把「脚本测试 → dev 人工验收 → 本地包验收 → 推 tag」固化成机器门控。
 *
 * 2026-11-11 的真实事故：脚本门控全绿就直接推 tag，跳过了「dev 版人工验收」
 * 和「本地包安装验收」两步，把一个 `names={names}` 未替换的坏注入推到线上
 * （语法合法、运行时抛错被 catch 吞掉，BYOK 模型静默不下发）。
 *
 * 机制：每个阶段写一份凭证，凭证绑定**当前 HEAD 的 commit SHA**。
 * 代码一改 SHA 就变，所有旧凭证自动失效，必须按顺序重走流程。
 * 这样「我记得测过」不再是有效证据，只有「这个 commit 上跑过」才是。
 *
 * 用法：
 *   node scripts/release-flow.mjs status          # 查看当前 HEAD 的流程进度
 *   node scripts/release-flow.mjs record verify    # 脚本门控全绿后自动写入
 *   node scripts/release-flow.mjs record dev       # 用户亲自跑 dev 版并确认可用后写入
 *   node scripts/release-flow.mjs record local     # 本地安装包安装验证通过后写入
 *   node scripts/release-flow.mjs require          # 推 tag 前校验三阶段齐全（失败退出 1）
 *
 * 落盘位置：.release-flow/<sha>.json（已在 .gitignore，属于本机验收记录）
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const root = process.cwd();
const dir = path.join(root, '.release-flow');

// 阶段顺序即流程顺序，缺一环都不允许推 tag。
const STAGES = [
  { key: 'verify', label: '脚本测试全绿（npm run verify）', manual: false },
  { key: 'dev', label: 'dev 版人工验收（用户亲自测试通过）', manual: true },
  { key: 'local', label: '本地安装包验收（安装后真机可用）', manual: true },
];

function git(args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

function headSha() {
  return git(['rev-parse', 'HEAD']);
}

function version() {
  return JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
}

function fileFor(sha) {
  return path.join(dir, `${sha}.json`);
}

function readFlow(sha) {
  try {
    return JSON.parse(fs.readFileSync(fileFor(sha), 'utf8'));
  } catch {
    return { sha, version: version(), stages: {} };
  }
}

function writeFlow(flow) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(fileFor(flow.sha), JSON.stringify(flow, null, 2), 'utf8');
}

function record(stageKey) {
  const stage = STAGES.find((s) => s.key === stageKey);
  if (!stage) {
    console.error(`未知阶段：${stageKey}（可选：${STAGES.map((s) => s.key).join(' / ')}）`);
    process.exit(2);
  }
  // 人工阶段必须显式声明「用户已确认」，避免自己给自己发合格证。
  if (stage.manual && !process.argv.includes('--user-confirmed')) {
    console.error(
      `❌ ${stage.label} 是人工验收阶段，必须由用户亲自确认后记录。\n` +
        `   确认后执行：node scripts/release-flow.mjs record ${stage.key} --user-confirmed`
    );
    process.exit(2);
  }
  const sha = headSha();
  const flow = readFlow(sha);
  flow.version = version();
  flow.stages = flow.stages || {};
  flow.stages[stage.key] = {
    at: new Date().toISOString(),
    label: stage.label,
    manual: stage.manual,
  };
  writeFlow(flow);
  console.log(`✅ 已记录 [${stage.key}] ${stage.label}`);
  console.log(`   commit=${sha.slice(0, 8)} version=${flow.version}`);
}

function status() {
  const sha = headSha();
  const flow = readFlow(sha);
  console.log(`当前 HEAD: ${sha.slice(0, 8)}  版本: ${version()}`);
  console.log('发版流程进度：');
  let missing = null;
  for (const stage of STAGES) {
    const hit = flow.stages?.[stage.key];
    const mark = hit ? '✅' : '⬜';
    const when = hit ? ` @ ${hit.at}` : '';
    console.log(`  ${mark} ${stage.key.padEnd(7)} ${stage.label}${when}`);
    if (!hit && !missing) missing = stage;
  }
  return { sha, flow, missing };
}

function requireAll() {
  const { sha, flow, missing } = status();
  if (missing) {
    console.log(
      `\n❌ 流程未走完，禁止推 tag：缺「${missing.label}」\n` +
        `   正确顺序：npm run verify → 起 dev 版给用户测 → 本地打包安装验证 → 才 push tag\n` +
        `   当前 commit ${sha.slice(0, 8)} 的验收记录不完整，跳过任何一步都可能把 bug 推到线上。`
    );
    process.exit(1);
  }
  console.log('\n✅ 三阶段验收齐全，允许推 tag。');
}

const cmd = process.argv[2] || 'status';
if (cmd === 'status') status();
else if (cmd === 'record') record(process.argv[3] || '');
else if (cmd === 'require') requireAll();
else {
  console.error(`未知命令：${cmd}`);
  process.exit(2);
}
