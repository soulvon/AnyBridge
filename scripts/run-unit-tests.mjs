import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// 只按 *.test.{js,mjs,cjs} 约定自动发现（scripts/ 与 sidecar/ 递归）。
// 禁止硬编码文件名：历史上硬编码引用过被 .gitignore 排除的 scripts/test-*.mjs，
// 本机有文件所以 verify 通过，CI 干净检出直接 Could not find 并 exit 1。
const tests = new Set();

function collect(dir) {
  const absolute = path.join(root, dir);
  if (!fs.existsSync(absolute)) return;
  for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const relative = path.posix.join(dir, entry.name);
    if (entry.isDirectory()) collect(relative);
    else if (/\.test\.(?:js|mjs|cjs)$/.test(entry.name)) tests.add(relative);
  }
}

collect('sidecar');
collect('scripts');

const files = [...tests].sort();
if (files.length === 0) {
  console.error('未发现任何单元测试，检查入口必须失败而不是空跑成功。');
  process.exit(1);
}

console.log(`运行 ${files.length} 个单元测试文件：`);
for (const file of files) console.log(`  ${file}`);

const result = spawnSync(process.execPath, ['--test', ...files], {
  cwd: root,
  stdio: 'inherit',
});
process.exit(result.status ?? 1);
