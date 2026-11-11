#!/usr/bin/env node
/**
 * 唯一允许推 tag 的入口：先校验三阶段验收凭证，再建附注 tag 并推送。
 *
 * 为什么要有这个脚本：2026-11-11 事故里，直接 `git tag + git push` 绕过了
 * 所有人工验收。把「推 tag」收敛成单一入口后，跳步在物理上就做不到。
 *
 * 用法：
 *   npm run release:push
 */
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const root = process.cwd();

function run(cmd, args, { allowFail = false } = {}) {
  try {
    return execFileSync(cmd, args, { cwd: root, encoding: 'utf8', stdio: 'pipe' }).trim();
  } catch (error) {
    if (allowFail) return null;
    const detail = [error.stdout, error.stderr].filter(Boolean).join('\n').trim();
    console.error(detail || error.message);
    process.exit(1);
  }
}

console.log('① 校验三阶段验收凭证');
run(process.execPath, ['scripts/release-flow.mjs', 'require']);

console.log('\n② 校验发版配置与工作区');
run(process.execPath, ['scripts/check-release-gate.mjs']);

const version = JSON.parse(fs.readFileSync('package.json', 'utf8')).version;
const tag = `v${version}`;

console.log(`\n③ 确认附注 tag ${tag}`);
const existing = run('git', ['rev-list', '-1', tag], { allowFail: true });
const head = run('git', ['rev-parse', 'HEAD']);
if (existing && existing !== head) {
  console.error(`❌ tag ${tag} 已存在但指向 ${existing.slice(0, 8)}，不是 HEAD ${head.slice(0, 8)}。`);
  console.error('   请 bump 版本号后重新走流程，不要复用旧 tag。');
  process.exit(1);
}
if (!existing) {
  run('git', ['tag', '-a', tag, '-m', `release: ${tag}`]);
  console.log(`   已创建附注 tag ${tag}`);
} else {
  console.log(`   tag ${tag} 已指向 HEAD，复用`);
}

console.log('\n④ 推送 main 与 tag');
run('git', ['push', 'origin', 'main'], {});
console.log('   main 已推送');
run('git', ['push', 'origin', tag], {});
console.log(`   ${tag} 已推送，Release workflow 启动`);

console.log('\n后续只允许「盯 CI」，任何 gh release create/upload 都是错的。');
