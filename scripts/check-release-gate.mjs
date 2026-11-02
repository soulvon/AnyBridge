#!/usr/bin/env node

// 发版门控。
//
// 2026-11-02 的真实事故：tag 已推送、云端 Release workflow 正在多平台打包时，
// 人工又执行了 `gh release create v1.0.12 + 本地 Windows 产物上传`，结果：
// 1) 产出一个「已发布」状态、只有 Windows 两个产物、release notes 手写的 release，
//    用户会提前看到不完整版本；
// 2) 创建时远端 tag 尚未就绪，GitHub 把它挂到 `untagged-*` 占位 tag 上，与 CI
//    按正式 tag 创建的 draft 形成两个同名 release，还要手工删除收尾。
//
// 正确流程（唯一入口，全部自动化，任何一步都不需要 gh release create）：
//   1. 提交代码，三处版本号一致，CHANGELOG 有当前版本章节
//   2. git tag -a v<version> -m "..." && git push origin main v<version>
//   3. Release workflow 自动：建 draft（notes 取自 CHANGELOG）→ 多平台构建
//      → 上传产物 → 发布
//   4. 期间唯一允许的操作是「盯 CI」，任何 gh release create/upload 都是错的
//
// 用法：
//   node scripts/check-release-gate.mjs            # 本地检查（工作区/版本/CHANGELOG/tag）
//   node scripts/check-release-gate.mjs --remote   # 追加远端检查（release 状态、tag 已推送）

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const root = process.cwd();
const args = process.argv.slice(2);
const withRemote = args.includes('--remote');

let passed = 0;
let failed = 0;
function ok(name, detail = '') {
  passed++;
  console.log(`  ✅ ${name}${detail ? ' — ' + detail : ''}`);
}
function bad(name, detail = '') {
  failed++;
  console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`);
}
function check(name, cond, detail = '') {
  if (cond) {
    ok(name, detail);
  } else {
    bad(name, detail);
  }
}
function section(name) {
  console.log(`\n■ ${name}`);
}
function git(args) {
  return execSync(`git ${args}`, { cwd: root, encoding: 'utf8' }).trim();
}

section('工作区');
let dirty = '';
try {
  dirty = git('status --porcelain');
} catch (error) {
  console.error('git 不可用：', error.message);
  process.exit(2);
}
check(
  '工作区干净（发版必须基于已提交代码）',
  dirty === '',
  dirty === '' ? '' : dirty.split('\n').slice(0, 5).join(' | ')
);

const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const tauriVersion = JSON.parse(fs.readFileSync(path.join(root, 'src-tauri/tauri.conf.json'), 'utf8')).version;
const sidecarVersion = JSON.parse(fs.readFileSync(path.join(root, 'sidecar/package.json'), 'utf8')).version;
check(
  '三处版本号一致',
  version === tauriVersion && version === sidecarVersion,
  version === tauriVersion && version === sidecarVersion ? '' : `package=${version} tauri=${tauriVersion} sidecar=${sidecarVersion}`
);

section('CHANGELOG');
const changelog = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
const heading = new RegExp(`^## v${version.replace(/\./g, '\\.')}\\s+-\\s+\\d{4}-\\d{2}-\\d{2}`, 'm');
check(`存在 v${version} 章节（CI 的 release notes 从这里提取）`, heading.test(changelog));

section('tag');
const tag = `v${version}`;
let tagCommit = '';
let tagExists = false;
try {
  // annotated tag 的 rev-parse 返回 tag 对象 SHA，且 {commit} 会被 Windows shell 吞掉，
  // 用 rev-list 直接取 tag 指向的 commit 最稳。
  tagCommit = git(`rev-list -1 ${tag}`);
  tagExists = tagCommit.length > 0;
} catch {
  tagExists = false;
}
if (tagExists) {
  const head = git('rev-parse HEAD');
  check(
    `tag ${tag} 已存在且指向 HEAD`,
    tagCommit === head,
    tagCommit === head ? '' : `${tag}=${tagCommit.slice(0, 8)} HEAD=${head.slice(0, 8)}`
  );
} else {
  ok(`tag ${tag} 尚未创建（推 tag 时 CI 会自动触发云端打包）`);
}

if (withRemote) {
  section('远端（--remote）');
  // tag 是否已推到远端
  let pushed = false;
  try {
    git(`ls-remote --exit-code origin refs/tags/${tag}`);
    pushed = true;
  } catch {
    pushed = false;
  }
  check(
    `tag ${tag} 已推送到 origin`,
    pushed,
    pushed ? '' : '推 tag 后 Release workflow 才会启动'
  );

  // 同 tag 的 release 状态：只允许「不存在」或「draft」（CI 建的、正在传产物）
  try {
    // jq 的复杂引号在 Windows shell 里会被吞，取全量后在这里过滤
    const json = execSync('gh api repos/:owner/:repo/releases', {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
    });
    const releases = JSON.parse(json || '[]')
      .filter((release) => release.tag_name === tag)
      .map((release) => ({
        id: release.id,
        name: release.name,
        draft: release.draft,
        tagName: release.tag_name,
      }));
    if (releases.length === 0) {
      ok(`远端还没有 ${tag} 的 release（CI 会自动创建 draft）`);
    } else {
      for (const release of releases) {
        const label = `release #${release.id}「${release.name}」`;
        if (release.draft) {
          ok(`${label} 处于 draft（CI 正在写入，等待它发布）`);
        } else {
          bad(`${label} 已是发布状态`, '这只可能来自人工 gh release create/upload——云端打包的 draft 必须由 CI 发布，删除后等 CI');
        }
        if (String(release.tagName).startsWith('untagged-')) {
          bad(`${label} 挂在 untagged 占位上`, '创建 release 时远端 tag 未就绪；删除它，让 CI 重建');
        }
      }
    }
  } catch (error) {
    bad('远端 release 检查失败', `gh api 出错：${String(error.message).slice(0, 120)}（gh 未登录或网络不通时可用本地模式重跑）`);
  }
}

console.log(`\n通过 ${passed} ｜ 失败 ${failed}`);
if (failed > 0) {
  console.log('\n发版流程（唯一入口，全程不需要 gh release create/upload）：');
  console.log('  1. 修完 → 提交 → bump 版本（三处一致）→ CHANGELOG 补章节');
  console.log('  2. npm run check:release-gate            # 本地检查');
  console.log('  3. git tag -a v<version> -m "..." && git push origin main v<version>');
  console.log('  4. 等 Release workflow：draft → 多平台构建 → 自动发布');
  process.exit(1);
}
console.log('发版门控通过。');
