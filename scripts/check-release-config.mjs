#!/usr/bin/env node
// 发布配置一致性门控。
//
// 两次真实发版失败的教训（2026-10-26 / 10-29，v0.6.1）：
// 1) `bundle.targets: ["nsis","msi"]` 只含 Windows 类型——本地 Windows 打包永远正常，
//    但 tauri-action 按 targets 生成产物匹配规则，CI 的 macOS/Linux 匹配为空，
//    报 `No artifacts were found.`（构建其实成功了，白跑 4 个平台 20 分钟）。
// 2) 版本号散落 8 处，手工改漏了 sidecar / lockfile；CHANGELOG 也漏了对应章节。
//
// 这个脚本把这两类"只有 CI 才会暴露"的错误提前到本地门控里。
// 用法：node scripts/check-release-config.mjs [--json]

import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const exists = (p) => fs.existsSync(path.join(root, p));

let passed = 0;
let failed = 0;
function ok(name, cond, detail = '') {
  if (cond) {
    passed++;
    console.log(`  ✅ ${name}`);
  } else {
    failed++;
    console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`);
  }
}
function section(name) {
  console.log(`\n■ ${name}`);
}

// ── 1. 版本号 8 处一致（RELEASE.md「版本管理」要求） ────────────────────
section('版本号一致性');
const pkgVersion = JSON.parse(read('package.json')).version;

const versionSources = [];
const push = (label, value) => versionSources.push([label, value]);

push('package.json', pkgVersion);
{
  const lock = JSON.parse(read('package-lock.json'));
  push('package-lock.json', lock.version);
  push('package-lock.json packages[""]', lock.packages?.['']?.version);
}
if (exists('sidecar/package.json')) {
  push('sidecar/package.json', JSON.parse(read('sidecar/package.json')).version);
}
if (exists('sidecar/package-lock.json')) {
  const lock = JSON.parse(read('sidecar/package-lock.json'));
  push('sidecar/package-lock.json', lock.version);
  push('sidecar/package-lock.json packages[""]', lock.packages?.['']?.version);
}
{
  const toml = read('src-tauri/Cargo.toml');
  const m = /\[package\][\s\S]*?\nversion\s*=\s*"([^"]+)"/.exec(toml);
  push('src-tauri/Cargo.toml', m ? m[1] : undefined);
}
{
  const lock = read('src-tauri/Cargo.lock');
  const m = /\[\[package\]\]\nname = "anybridge"\nversion = "([^"]+)"/.exec(lock);
  push('src-tauri/Cargo.lock', m ? m[1] : undefined);
}
{
  const conf = JSON.parse(read('src-tauri/tauri.conf.json'));
  push('src-tauri/tauri.conf.json', conf.version);
}

for (const [label, value] of versionSources) {
  ok(`${label} = ${pkgVersion}`, value === pkgVersion, `实际 ${value ?? '(未读到)'}`);
}

// ── 2. CHANGELOG 必须有当前版本章节 ───────────────────────────────────
section('更新说明');
const changelog = read('CHANGELOG.md');
ok(`CHANGELOG.md 含 ## v${pkgVersion} 章节`, changelog.includes(`## v${pkgVersion}`));

// ── 3. bundle.targets 必须跨平台安全 ──────────────────────────────────
section('跨平台打包配置');
const tauriConf = JSON.parse(read('src-tauri/tauri.conf.json'));
const targets = tauriConf.bundle?.targets;
const WINDOWS_ONLY = new Set(['nsis', 'msi']);

if (targets === 'all' || targets === undefined) {
  ok('bundle.targets = all（各平台按自身支持类型构建）', true);
} else if (Array.isArray(targets)) {
  const winOnly = targets.length > 0 && targets.every((t) => WINDOWS_ONLY.has(t));
  ok(
    'bundle.targets 覆盖非 Windows 平台',
    !winOnly,
    winOnly
      ? `targets=${JSON.stringify(targets)} 只含 Windows 类型：CI 的 macOS/Linux 产物匹配为空（实测 No artifacts were found）`
      : ''
  );
} else {
  ok('bundle.targets 取值合法', false, `实际 ${JSON.stringify(targets)}`);
}

const updaterArtifacts = tauriConf.bundle?.createUpdaterArtifacts;
if (updaterArtifacts) {
  ok(
    '开启 updater 产物时 targets 覆盖三平台（all 或含 app/deb/rpm/appimage）',
    targets === 'all' ||
      targets === undefined ||
      (Array.isArray(targets) &&
        ['app', 'dmg', 'deb', 'rpm', 'appimage'].some((t) => targets.includes(t))),
    'updater 需要 macOS .app.tar.gz / Linux .AppImage.tar.gz / Windows .msi.zip｜.nsis.zip'
  );
}

// ── 4. release.yml 三平台矩阵 + 签名预检 ──────────────────────────────
section('CI 发布矩阵');
if (exists('.github/workflows/release.yml')) {
  const yml = read('.github/workflows/release.yml');
  ok('release.yml 覆盖 Windows', /windows-latest/.test(yml));
  ok('release.yml 覆盖 macOS', /macos-latest/.test(yml));
  ok('release.yml 覆盖 Linux', /ubuntu-/.test(yml));
  ok('release.yml 有签名 secret 预检步骤', yml.includes('Validate updater signing secret'));
  ok('release.yml 使用 tauri-action 上传产物', yml.includes('tauri-apps/tauri-action'));
} else {
  ok('release.yml 存在', false);
}

// ── 5. tag 语义：已存在的同名 tag 必须指向 HEAD ────────────────────────
// 事故背景：v0.6.1 首次发布时 tag 指向含错误的旧提交，CI 重跑无效，
// 最终必须删 tag 重打。这条检查让「tag 与代码不一致」在发版前就暴露。
section('发布标签');
try {
  const { execSync } = await import('node:child_process');
  const tag = `v${pkgVersion}`;
  const tags = execSync('git tag -l', { encoding: 'utf8' })
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!tags.includes(tag)) {
    ok(`tag ${tag} 尚未创建（发布时新建）`, true);
  } else {
    const tagSha = execSync(`git rev-list -n 1 ${tag}`, { encoding: 'utf8' }).trim();
    const headSha = execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();
    const same = tagSha === headSha;
    ok(
      `已存在的 tag ${tag} 指向当前 HEAD`,
      same,
      same
        ? ''
        : `tag 指向 ${tagSha.slice(0, 8)}、HEAD 是 ${headSha.slice(0, 8)}：直接重推 tag 不会带上新提交，需先 git push origin :refs/tags/${tag} 再重打`
    );
  }
} catch (e) {
  ok('git 环境可用于 tag 检查', false, String(e).slice(0, 140));
}

// ── 汇总 ─────────────────────────────────────────────────────────────
console.log(`\n${'═'.repeat(36)}`);
console.log(`通过 ${passed} ｜ 失败 ${failed}`);
if (failed > 0) {
  console.log('❌ 发布配置不一致——修复后再发版');
  process.exit(1);
}
console.log('✅ 发布配置通过');
