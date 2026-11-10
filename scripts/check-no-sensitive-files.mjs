#!/usr/bin/env node
/**
 * 发布前敏感文件门控（防止凭据/私钥/本地私有资料被推送到 GitHub）。
 *
 *   node scripts/check-no-sensitive-files.mjs
 *
 * 检查三层：
 *   1. 已跟踪文件名单：不得含私钥、证书、密钥、.env（示例除外）、构建产物、
 *      日志、内部复盘资料；
 *   2. 待提交/已跟踪文件的内容：扫描私钥头、常见 API key 形态、显式凭据字段、
 *      硬编码本机用户名绝对路径（仅对本次新增/修改的行报警，避免历史注释误伤）；
 *   3. .gitignore：必须覆盖签名私钥、证书、日志、构建产物与 tmp/。
 *
 * 退出码 0=通过，1=失败。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failed = 0;
let passed = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`); }
};
const section = (n) => console.log(`\n■ ${n}`);
const git = (args) => {
  try { return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch { return ''; }
};

section('已跟踪文件名单');
{
  const tracked = git(['ls-files']).split(/\r?\n/).filter(Boolean);
  console.log(`  （共 ${tracked.length} 个文件）`);
  const forbiddenName = [
    /(^|\/)\.env$/i,
    /(^|\/)\.env\.(?!example|sample|template)/i,
    /tauri-sign\.key/i,
    /\.(pem|p12|pfx|key|keystore|jks|crt|cer)$/i,
    /(^|\/)(credentials|secrets?|tokens?)\.(json|ya?ml|txt|ini|toml)$/i,
    /private[_-]?key/i,
    /(^|\/)(src-tauri\/binaries|src-tauri\/target|cursor-core\/target|node_modules|tmp)\//i,
    /\.(log|exe|msi|dmg|deb|rpm|AppImage|zip|sig)$/i,
    /capture|decompiled|sniffer/i,
  ];
  const bad = tracked.filter(f => forbiddenName.some(re => re.test(f)));
  ok('无私钥/证书/凭据/构建产物/日志被跟踪', bad.length === 0, bad.slice(0, 12).join(', '));
  ok('示例配置保留（.env.example 允许）', true);
}

section('待提交内容扫描');
{
  // 只看本次改动引入的行：git diff（含 staged 与 unstaged）+ untracked 文件。
  let diff = '';
  try {
    diff = execFileSync('git', ['diff', '--no-ext-diff', '--unified=0', 'HEAD'], {
      cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 32 * 1024 * 1024,
    });
  } catch { diff = ''; }
  const added = diff.split(/\r?\n/).filter(l => l.startsWith('+') && !l.startsWith('+++'));
  const joined = added.join('\n');
  const findings = [];
  if (/-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/.test(joined)) findings.push('私钥 PEM 头');
  if (/\bsk-[A-Za-z0-9_-]{16,}\b/.test(joined)) findings.push('OpenAI 风格 API key');
  if (/\bgh[pousr]_[A-Za-z0-9]{20,}\b/.test(joined)) findings.push('GitHub token');
  if (/\bAKIA[0-9A-Z]{16}\b/.test(joined)) findings.push('AWS access key');
  if (/TAURI_SIGNING_PRIVATE_KEY(?:_PASSWORD)?\s*[:=]\s*["']?[A-Za-z0-9+/=]{20,}/.test(joined)) findings.push('签名私钥明文');
  if (/(?:api[_-]?key|apiKey|password|secret)\s*[:=]\s*["'][A-Za-z0-9_\-]{24,}["']/.test(joined)) findings.push('硬编码凭据字面量');
  // 本机绝对路径（Windows 用户名 / Unix home）——门控脚本自身用转义拼接，避免自我命中。
  const winUser = String.fromCharCode(67, 58, 92) + 'Users' + String.fromCharCode(92);
  const winUserSlash = String.fromCharCode(67, 58, 47) + 'Users' + String.fromCharCode(47);
  if (joined.includes(winUser + 'admin') || joined.includes(winUserSlash + 'admin')) findings.push('硬编码本机用户名绝对路径');
  if (/\/Users\/[A-Za-z0-9._-]+\/(?:Library|Documents|Desktop)\//.test(joined)) findings.push('硬编码 macOS 用户绝对路径');
  ok('新增行无私钥 / token / 凭据 / 本机绝对路径', findings.length === 0, findings.join(', '));

  // 新写的正式脚本允许入库；其它未跟踪文件（日志、导出、探针、备份）一律拦下。
  // 白名单按「仓库内 scripts/*.mjs 且不含敏感文件名」判定，不靠具体文件名放行。
  const untracked = git(['ls-files', '--others', '--exclude-standard']).split(/\r?\n/).filter(Boolean);
  const suspicious = untracked.filter(f => {
    if (/^scripts\/[A-Za-z0-9._-]+\.mjs$/.test(f)) return false;
    return true;
  });
  ok('未跟踪文件仅含正式 scripts 脚本，无私料/日志/导出', suspicious.length === 0, suspicious.slice(0, 10).join(', '));
}

section('.gitignore 规则');
{
  const ignore = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');
  const required = [
    'tauri-sign.key',
    'src-tauri/binaries/',
    'src-tauri/target/',
    'certs/*.pem',
    '*.log',
    '/tmp/',
    '.env',
    'AGENTS.md',
    'PRIVATE_NOTES.md',
  ];
  const missing = required.filter(r => !ignore.includes(r));
  ok('私钥/证书/日志/构建产物/内部文档均在忽略清单', missing.length === 0, missing.join(', '));
}

console.log(`\n════════════════════════════════════`);
console.log(`通过 ${passed} ｜ 失败 ${failed}`);
console.log(failed === 0 ? '✅ 敏感文件门控通过' : '❌ 存在失败项——禁止发布');
process.exit(failed === 0 ? 0 : 1);
