#!/usr/bin/env node
// 发布后资产核对（RELEASE 流程第⑦步的自动化）。
//
// 背景：CI 是全自动发布的（主仓库与公共仓库都会 --draft=false --latest），
// 所以「产物齐不齐、签名在不在、latest.json 能不能让客户端升级」必须事后核对，
// 否则用户端可能收不到更新而无人察觉（v0.5.38 曾整轮发布失败）。
//
// 用法：
//   node scripts/check-release-assets.mjs            # 用 package.json 版本
//   node scripts/check-release-assets.mjs v0.6.2     # 指定版本
//
// 依赖：gh CLI（已登录，有仓库读权限）；CI 完成后稍等一两分钟再跑。

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SOURCE_REPO = 'soulvon/AnyBridge';
const PUBLIC_REPO = 'soulvon/AnyBridge-Release';

const argVersion = process.argv[2]?.replace(/^v/, '');
const version = argVersion || JSON.parse(fs.readFileSync('package.json', 'utf8')).version;
const tag = `v${version}`;

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
function ghJson(args) {
  const out = execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return JSON.parse(out);
}

const hasAsset = (names, re) => names.some((n) => re.test(n));

function checkAssets(repoLabel, assets) {
  const names = assets.map((a) => a.name);
  section(`${repoLabel} 安装包`);
  ok('Windows .exe 安装包', hasAsset(names, /x64-setup\.exe$/));
  ok('Windows .msi 安装包', hasAsset(names, /x64.*\.msi$/));
  ok('macOS .dmg 安装包', hasAsset(names, /\.dmg$/));
  ok('macOS updater 包（.app.tar.gz）', hasAsset(names, /\.app\.tar\.gz$/));
  ok('Linux AppImage 安装包', hasAsset(names, /\.AppImage$/));
  ok('Linux .deb 安装包', hasAsset(names, /\.deb$/));

  section(`${repoLabel} 签名`);
  // 签名只覆盖「更新器会下载的产物」：.msi/.exe 的 updater 包、.app.tar.gz、.AppImage。
  // .dmg 不参与 updater，Tauri 不为其生成 .sig —— 不要把缺 .dmg.sig 当失败。
  ok('Windows .exe 签名', hasAsset(names, /x64-setup\.exe\.sig$/));
  ok('Windows .msi 签名', hasAsset(names, /x64.*\.msi\.sig$/));
  ok('macOS updater 签名（.app.tar.gz.sig）', hasAsset(names, /\.app\.tar\.gz\.sig$/));
  ok('Linux AppImage 签名', hasAsset(names, /\.AppImage\.sig$/));
  ok('Linux .deb 签名', hasAsset(names, /\.deb\.sig$/));
}

function checkLatestJson(assets) {
  section('更新清单 latest.json');
  const names = assets.map((a) => a.name);
  if (!names.includes('latest.json')) {
    ok('latest.json 已上传', false);
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anybridge-latest-'));
  try {
    execFileSync(
      'gh',
      ['release', 'download', tag, '--repo', SOURCE_REPO, '--pattern', 'latest.json', '--dir', dir, '--clobber'],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    );
    const latest = JSON.parse(fs.readFileSync(path.join(dir, 'latest.json'), 'utf8'));
    ok('latest.json 版本与发布版本一致', latest.version === version, `实际 ${latest.version}`);
    // 更新弹窗的数据源：客户端 updater 读 notes → update.body → 弹窗渲染
    const notes = String(latest.notes || '').trim();
    ok(
      'latest.json 含更新说明（notes 非空）',
      notes.length >= 20,
      `实际 ${notes.length} 字符 → 客户端更新弹窗会显示「无详细更新说明」`
    );
    const platforms = latest.platforms || {};
    const keys = Object.keys(platforms);
    ok('覆盖 Windows 平台', keys.some((k) => k.startsWith('windows')), `keys=${keys.join(',')}`);
    ok('覆盖 macOS 平台', keys.some((k) => k.startsWith('darwin')), `keys=${keys.join(',')}`);
    ok('覆盖 Linux 平台', keys.some((k) => k.startsWith('linux')), `keys=${keys.join(',')}`);
    const bad = keys.filter((k) => {
      const p = platforms[k] || {};
      return !p.url || !p.signature;
    });
    ok('每个平台都有 url 与 signature', bad.length === 0, bad.length ? `缺字段: ${bad.join(',')}` : '');
  } catch (e) {
    ok('latest.json 可下载并解析', false, String(e).slice(0, 160));
  }
}

// ── 主仓库 ───────────────────────────────────────────────────────────
section(`主仓库 ${SOURCE_REPO} ${tag}`);
let mainAssets = [];
try {
  const rel = ghJson([
    'release', 'view', tag, '--repo', SOURCE_REPO,
    '--json', 'tagName,isDraft,isPrerelease,assets,createdAt'
  ]);
  ok('release 存在', rel.tagName === tag);
  ok('已正式发布（非 draft）', rel.isDraft === false);
  ok('已标记 latest（非 prerelease）', rel.isPrerelease === false);
  mainAssets = rel.assets || [];
} catch (e) {
  ok('release 可查询', false, String(e).slice(0, 160));
}

if (mainAssets.length) {
  checkAssets('主仓库', mainAssets);
  checkLatestJson(mainAssets);
}

// ── 公共仓库（更新器分发）────────────────────────────────────────────
section(`公共仓库 ${PUBLIC_REPO} ${tag}`);
try {
  const rel = ghJson([
    'release', 'view', tag, '--repo', PUBLIC_REPO,
    '--json', 'tagName,isDraft,isPrerelease,assets'
  ]);
  ok('release 存在', rel.tagName === tag);
  ok('已正式发布（非 draft）', rel.isDraft === false);
  checkAssets('公共仓库', rel.assets || []);
} catch (e) {
  ok('release 可查询', false, String(e).slice(0, 160));
}

// ── 汇总 ─────────────────────────────────────────────────────────────
console.log(`\n${'═'.repeat(36)}`);
console.log(`通过 ${passed} ｜ 失败 ${failed}`);
if (failed > 0) {
  console.log('❌ 发布产物不完整——检查 CI 日志对应的平台 job');
  process.exit(1);
}
console.log('✅ 发布产物完整');
