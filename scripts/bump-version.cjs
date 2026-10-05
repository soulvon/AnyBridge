// 版本号同步脚本（按 spec/32-打包指南 的文件清单）
// 用法: node scripts/bump-version.cjs 0.5.26
// 仅做精确上下文替换，不重写文件结构。
const fs = require('fs');
const path = require('path');

const next = process.argv[2];
if (!/^\d+\.\d+\.\d+$/.test(String(next || ''))) {
  console.error('用法: node scripts/bump-version.cjs <x.y.z>');
  process.exit(1);
}

const root = path.resolve(__dirname, '..');
const results = [];

function readRel(rel) {
  return fs.readFileSync(path.join(root, rel), 'utf-8');
}

function writeRel(rel, text) {
  fs.writeFileSync(path.join(root, rel), text, 'utf-8');
}

// 精确替换：锚点 + from 版本；active 必须命中，否则报错
function replaceOnce(rel, from, to, anchor, expectCount = 1) {
  const content = readRel(rel);
  const re = new RegExp(anchor.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + from, 'g');
  const hits = (content.match(re) || []).length;
  if (hits !== expectCount) {
    throw new Error(`${rel}: 期望 ${expectCount} 处 "${anchor}${from}"，实际 ${hits} 处`);
  }
  writeRel(rel, content.replace(re, anchor + to));
  results.push(`${rel} (${hits}处)`);
}

function detectVersion() {
  const pkg = JSON.parse(readRel('package.json'));
  return pkg.version;
}

const from = detectVersion();
console.log(`版本升级: ${from} -> ${next}`);

replaceOnce('package.json', from, next, '"version": "');
replaceOnce('package-lock.json', from, next, '"name": "anybridge",\n  "version": "');
replaceOnce('package-lock.json', from, next, '"": {\n      "name": "anybridge",\n      "version": "');
replaceOnce('sidecar/package.json', from, next, '"version": "');
replaceOnce('sidecar/package-lock.json', from, next, '"name": "anybridge-sidecar",\n  "version": "');
replaceOnce('sidecar/package-lock.json', from, next, '"": {\n      "name": "anybridge-sidecar",\n      "version": "');
replaceOnce('src-tauri/Cargo.toml', from, next, '[package]\nname = "anybridge"\nversion = "');
replaceOnce('src-tauri/Cargo.lock', from, next, '[[package]]\nname = "anybridge"\nversion = "');
replaceOnce('src-tauri/tauri.conf.json', from, next, '"version": "');

console.log('已更新:');
for (const r of results) console.log('  -', r);
