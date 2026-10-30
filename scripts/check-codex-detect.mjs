// ═══════════════════════════════════════════════════════════════════
// Codex 进程判定矩阵门控
//
// 背景：Codex 在同一台机器上可能有四种形态，其中三种都叫 codex.exe，
// 判定错了后果不对称——把 CLI 认成 Desktop 会杀掉用户正在跑的 CLI 会话，
// 还会让「启动 Codex」永远返回「已在运行」（2026-10 实测复现并修复）。
//
// 做法：不复制判定逻辑，直接从 codex_desktop.rs 抽出 PS_CODEX_DESKTOP_PROCESS_FILTER
// 原文，喂真实路径样本执行，断言每一类的 UiHostOnly 结果。
// 非 Windows 无 pwsh，跳过（该逻辑本身只在 Windows 编译）。
// ═══════════════════════════════════════════════════════════════════
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

const RS = 'src-tauri/src/commands/codex_desktop.rs';

if (process.platform !== 'win32') {
  console.log('⏭ 非 Windows，跳过 Codex 进程判定矩阵');
  process.exit(0);
}

const src = fs.readFileSync(RS, 'utf8');
const m = src.match(/const PS_CODEX_DESKTOP_PROCESS_FILTER: &str = r#"([\s\S]*?)"#;/);
if (!m) {
  console.error(`❌ 未能从 ${RS} 抽取 PS_CODEX_DESKTOP_PROCESS_FILTER（判定逻辑被改名或挪走）`);
  process.exit(1);
}
const filterFn = m[1];

// 路径用通用形态，不含真实用户名/盘符，换机器不漂移。
const CLI_DIR =
  'D:\\tools\\npm\\node_modules\\@openai\\codex\\node_modules\\@openai\\codex-win32-x64\\vendor\\x86_64-pc-windows-msvc\\bin\\codex.exe';
const MSIX_DIR =
  'C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.1023.6621.0_x64__2p2nqsd0c76g0';

const samples = [
  {
    label: 'CLI（npm 全局包 vendor/bin）',
    name: 'codex.exe',
    path: CLI_DIR,
    cmd: `"${CLI_DIR}"`,
    expect: false,
  },
  {
    label: 'CLI 子命令 codex app-server（只算 helper）',
    name: 'codex.exe',
    path: CLI_DIR,
    cmd: `"${CLI_DIR}" app-server`,
    expect: false,
  },
  {
    label: '新版 Desktop 宿主 ChatGPT.exe（MSIX）',
    name: 'ChatGPT.exe',
    path: `${MSIX_DIR}\\ChatGPT.exe`,
    cmd: `"${MSIX_DIR}\\ChatGPT.exe"`,
    expect: true,
  },
  {
    label: '旧版 Desktop 宿主 Codex.exe（用户安装目录）',
    name: 'Codex.exe',
    path: 'D:\\Apps\\Codex\\Codex.exe',
    cmd: '"D:\\Apps\\Codex\\Codex.exe"',
    expect: true,
  },
  {
    label: '包内 app-server helper',
    name: 'codex.exe',
    path: `${MSIX_DIR}\\resources\\codex.exe`,
    cmd: `"...\\resources\\codex.exe" --app-server`,
    expect: false,
  },
];

const ps = [
  filterFn,
  '$rows = @()',
  ...samples.map((s, i) => {
    const p = `@{ Name = '${s.name}'; ExecutablePath = '${s.path.replace(/'/g, "''")}'; CommandLine = '${s.cmd.replace(/'/g, "''")}' }`;
    return `$rows += [pscustomobject]@{ idx = ${i}; ui = (Test-CodexDesktopProcess (${p}) -UiHostOnly) }`;
  }),
  '$rows | ConvertTo-Json -Compress',
].join('\n');

const tmpFile = path.join(os.tmpdir(), `anybridge-codex-detect-${process.pid}.ps1`);
fs.writeFileSync(tmpFile, ps, 'utf8');

let rows = [];
try {
  const r = spawnSync('pwsh', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', tmpFile], {
    encoding: 'utf8',
  });
  if (r.error) {
    console.error(`❌ 调用 pwsh 失败: ${r.error.message}`);
    process.exit(1);
  }
  if (r.status !== 0) {
    console.error(`❌ 判定脚本执行失败: ${(r.stderr || r.stdout || '').trim().slice(0, 400)}`);
    process.exit(1);
  }
  rows = JSON.parse(r.stdout.trim());
} finally {
  try { fs.unlinkSync(tmpFile); } catch {}
}

let bad = 0;
for (let i = 0; i < samples.length; i++) {
  const s = samples[i];
  const row = rows.find(x => x.idx === i);
  const got = row ? row.ui : null;
  const pass = got === s.expect;
  if (!pass) bad++;
  console.log(`  ${pass ? '✅' : '❌'} ${s.label} → UiHostOnly=${got}（期望 ${s.expect}）`);
}

console.log(`\nCodex 进程判定矩阵：${samples.length - bad}/${samples.length} 符合预期`);
process.exit(bad ? 1 : 0);
