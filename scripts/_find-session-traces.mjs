/**
 * 查找会话痕迹 / 未提交备份 / 大 index 回滚相关文件
 * 用法: node scripts/_find-session-traces.mjs
 */
import { existsSync, readdirSync, statSync, readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const SESSION = 'cd830e83-6bfd-45de-b213-63d014ee4317';
const SHORT = 'cd830e83';
const roots = [
  process.cwd(),
  path.join(process.cwd(), '.codebuddy'),
  path.join(os.homedir(), '.codebuddy'),
  path.join(process.env.APPDATA || '', 'CodeBuddy'),
  path.join(process.env.APPDATA || '', 'codebuddy'),
  path.join(process.env.LOCALAPPDATA || '', 'CodeBuddy'),
  path.join(process.env.LOCALAPPDATA || '', 'codebuddy'),
  path.join(os.homedir(), 'AppData', 'Roaming', 'CodeBuddy'),
  path.join(os.homedir(), 'AppData', 'Local', 'CodeBuddy'),
  'e:/project/AnyBridge',
  'e:/project',
];

const hits = [];
const SKIP = new Set(['node_modules', '.git', 'target', 'dist', 'build', 'AppData\\Local\\Temp']);

function walk(dir, depth, maxDepth) {
  if (depth > maxDepth) return;
  let ents;
  try {
    ents = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of ents) {
    const name = ent.name;
    if (SKIP.has(name) || name.startsWith('.')) {
      // still allow .codebuddy
      if (name !== '.codebuddy' && name.startsWith('.')) continue;
    }
    const full = path.join(dir, name);
    if (name.includes(SHORT) || name.includes(SESSION) || name.includes('sess_')) {
      hits.push(full);
    }
    if (ent.isDirectory()) {
      if (['node_modules', '.git', 'target', 'dist'].includes(name)) continue;
      walk(full, depth + 1, maxDepth);
    }
  }
}

console.log('Searching session traces for', SESSION);
for (const root of roots) {
  if (!root || !existsSync(root)) {
    console.log('MISS', root);
    continue;
  }
  console.log('SCAN', root);
  walk(root, 0, root.includes('AppData') || root.endsWith('project') ? 3 : 5);
}

console.log('\nHITS', hits.length);
hits.slice(0, 50).forEach((h) => console.log(' -', h));

// also look for large index backups
console.log('\nLooking for index.html backups / large html near project...');
const backupPatterns = [/index\.html/i, /index\.bak/i, /index\.old/i, /proxy.*tab/i];
const backupHits = [];
function walkBackups(dir, depth) {
  if (depth > 3) return;
  let ents;
  try {
    ents = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of ents) {
    if (['node_modules', '.git', 'target'].includes(ent.name)) continue;
    const full = path.join(dir, ent.name);
    if (ent.isFile() && /index.*\.html|ui.*backup|partials/i.test(ent.name)) {
      try {
        const st = statSync(full);
        if (st.size > 50_000) backupHits.push({ full, size: st.size });
      } catch {}
    }
    if (ent.isDirectory() && depth < 3) walkBackups(full, depth + 1);
  }
}
walkBackups(process.cwd(), 0);
backupHits
  .sort((a, b) => b.size - a.size)
  .slice(0, 20)
  .forEach((x) => console.log(`${x.size}\t${x.full}`));

console.log('\nDONE');
