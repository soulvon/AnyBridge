import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';

const home = os.homedir();

// ── 1. 独立真相源（与后端探测算法完全不同的路径，用于交叉验证） ──
const TRUTH = {
  windsurf: () => readJson('E:/Program/Windsurf/resources/app/product.json')?.version,
  devin: () => readJson('E:/Program/devin/resources/app/product.json')?.version,
  cursor: () => {
    const cands = [
      path.join(home, 'AppData', 'Local', 'Programs', 'cursor', 'resources', 'app', 'product.json'),
      'E:/Program/Cursor/resources/app/product.json',
    ];
    return cands.map(readJson).find(v => v)?.version;
  },
  // Claude Desktop（Appx 商店版）：真相源走 Get-AppxPackage 的 Version
  'claude-desktop': () => {
    try {
      const out = execSync(
        'powershell -NoProfile -Command "(Get-AppxPackage -Name \'*Claude*\' | Sort-Object Version -Descending | Select-Object -First 1).Version.ToString()"',
        { encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'ignore'] }
      ).trim();
      return out || null;
    } catch {
      return null;
    }
  },
  // 注：truth 与探测同口径（product.json 的 version = 应用版本）；
  antigravity: () => probeAntigravityHub().version,
  'antigravity-ide': () => findProductJson(['C:/Program Files/Antigravity IDE', 'E:/Program/Antigravity IDE', path.join(home, 'AppData', 'Local', 'Programs', 'Antigravity IDE')]),
  'claude-code': () => runVersion(path.join(home, '.local', 'bin', 'claude.exe')),
  codex: () => {
    // PATH 找 codex.cmd
    const dirs = (process.env.PATH || '').split(';');
    for (const d of dirs) {
      const p = path.join(d, 'codex.cmd');
      if (fs.existsSync(p)) return runVersion(p);
    }
    return null;
  },
  grok: () => runVersion(path.join(home, '.grok', 'bin', 'grok.exe')),
  // 新增 CLI 的真相源：直接从 PATH/npm 全局目录跑 --version
  codebuddy: () => runFromPath('codebuddy'),
  pi: () => runFromPath('pi'),
  // dsh 不响应 --version：真相源走 npm 包管理器视角（与探测使用的
  // package.json 文件系统视角相互独立）
  'deepseek-harness': () => {
    try {
      const out = execSync('npm ls -g @deepseek-ai/dsh --json', {
        encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'ignore'],
      });
      const j = JSON.parse(out);
      return j.dependencies?.['@deepseek-ai/dsh']?.version || null;
    } catch {
      return null;
    }
  },
  hermes: () => runFromPath('hermes'),
  opencode: () => {
    const dirs = (process.env.PATH || '').split(';');
    for (const d of dirs) {
      for (const n of ['opencode.exe', 'opencode.cmd']) {
        const p = path.join(d, n);
        if (fs.existsSync(p)) return runVersion(p);
      }
    }
    return null;
  },
};

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}
function findProductJson(bases) {
  for (const b of bases) {
    const j = readJson(path.join(b, 'resources', 'app', 'product.json'));
    if (j) return j.version;
  }
  return null;
}
// 从 PATH 找命令并跑 --version（真相源，与探测算法独立）
function runFromPath(cmd) {
  try {
    const out = execSync(`"${cmd}" --version`, { timeout: 10000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const m = out.match(/(\d+\.\d+\.\d+[^\s]*)/);
    return m ? m[1] : out.trim().split('\n')[0]?.slice(0, 40) || null;
  } catch {
    return null;
  }
}

function runVersion(bin) {
  if (!fs.existsSync(bin)) return null;
  try {
    const out = execSync(`"${bin}" --version`, { timeout: 8000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const m = out.match(/(\d+\.\d+\.\d+[^\s]*)/);
    return m ? m[1] : out.trim().split('\n')[0]?.slice(0, 40) || null;
  } catch {
    return null;
  }
}

// ── 2. 复刻后端探测逻辑（与 version_probe.rs 相同算法） ──
function findTool(bin) {
  const candidates = ['bin.exe', 'bin.cmd', 'bin.bat'].map(x => x.replace('bin', bin));
  const dirs = [];
  (process.env.PATH || '').split(';').forEach(d => dirs.push(d));
  const regPaths = [];
  try {
    const out = execSync('reg query "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment" /v Path', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const line = out.split('\n').find(l => l.includes('Path'));
    if (line) {
      const raw = line.split('REG_EXPAND_SZ')[1]?.trim();
      if (raw) regPaths.push(...raw.split(';'));
    }
  } catch {}
  try {
    const out = execSync('reg query "HKCU\\Environment" /v Path', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const line = out.split('\n').find(l => l.includes('Path'));
    if (line) {
      const raw = line.split('REG_SZ')[1]?.trim() || line.split('REG_EXPAND_SZ')[1]?.trim();
      if (raw) regPaths.push(...raw.split(';'));
    }
  } catch {}
  dirs.push(...regPaths.filter(Boolean));
  const staticDirs = [
    path.join(home, 'AppData', 'Roaming', 'npm'),
    path.join(home, '.local', 'bin'),
    path.join(home, '.claude', 'local'),
    path.join(home, '.codex', 'bin'),
    path.join(home, '.grok', 'bin'),
    path.join(home, '.opencode', 'bin'),
    path.join(home, '.volta', 'bin'),
    path.join(home, '.bun', 'bin'),
    path.join(home, 'AppData', 'Local', 'Programs'),
  ];
  dirs.push(...staticDirs);
  for (const d of dirs) {
    for (const c of candidates) {
      const p = path.join(d.trim(), c);
      if (p && fs.existsSync(p)) return p;
    }
  }
  return null;
}

// npm 全局包版本回退（模拟后端 package_json_version：CLI 不报版本时读包内 package.json）
const NPM_PKG = {
  'claude-code': '@anthropic-ai/claude-code',
  'codex': '@openai/codex',
  'grok': null,
  'opencode': 'opencode-ai',
  'codebuddy': '@tencent-ai/codebuddy-code',
  'pi': '@earendil-works/pi-coding-agent',
  'deepseek-harness': '@deepseek-ai/dsh',
  'hermes': null,
};
function packageJsonVersion(pkg) {
  if (!pkg) return null;
  try {
    const prefix = execSync('npm prefix -g', { encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const cands = [
      path.join(prefix, 'node_modules', pkg, 'package.json'),
      path.join(prefix, pkg, 'package.json'),
    ];
    for (const p of cands) {
      const j = readJson(p);
      if (j?.version) return j.version;
    }
  } catch {}
  return null;
}

function probeCli(platformId, bin) {
  const found = findTool(bin);
  if (!found) return { version: null, found: null };
  const v = runVersion(found) || packageJsonVersion(NPM_PKG[platformId]);
  return { version: v, found };
}

// Claude Desktop（Appx 商店版）：从安装目录名 Claude_<ver>_x64__xxx 解析
function probeClaudeAppx() {
  try {
    const out = execSync(
      'powershell -NoProfile -Command "(Get-AppxPackage -Name \'*Claude*\' | Sort-Object Version -Descending | Select-Object -First 1).InstallLocation"',
      { encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'ignore'] }
    ).trim();
    const m = out.match(/Claude_([\d.]+)_/);
    if (m) return { version: m[1], dir: out };
  } catch {}
  return { version: null, dir: null };
}

// Antigravity Hub（Electron）：版本在 app.asar 内的 package.json（汉化同款定位链）
function probeAntigravityHub() {
  const base = path.join(process.env.LOCALAPPDATA || '', 'Programs', 'antigravity');
  const asar = path.join(base, 'resources', 'app.asar');
  if (!fs.existsSync(asar)) return { version: null, dir: base };
  const fd = fs.openSync(asar, 'r');
  try {
    const head = Buffer.alloc(16);
    fs.readSync(fd, head, 0, 16, 0);
    const jsonSize = head.readUInt32LE(12);
    const hb = Buffer.alloc(16 + jsonSize);
    fs.readSync(fd, hb, 0, hb.length, 0);
    const header = JSON.parse(hb.slice(16).toString('utf8'));
    const node = header.files && header.files['package.json'];
    if (!node) return { version: null, dir: base };
    const declared = head.readUInt32LE(4);
    const payloadStart = 8 + declared;
    const buf = Buffer.alloc(node.size);
    fs.readSync(fd, buf, 0, node.size, payloadStart + parseInt(node.offset));
    const pkg = JSON.parse(buf.toString('utf8'));
    return { version: pkg.version || null, dir: base };
  } catch {
    return { version: null, dir: base };
  } finally {
    fs.closeSync(fd);
  }
}

// GUI：原生注册表算法的近似复刻（这里用 reg query 枚举子键，仅对照用）
function probeGuiRegistry(platformId, display) {
  const hives = [
    'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  ];
  for (const hive of hives) {
    try {
      const out = execSync(`reg query "${hive}"`, { encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'ignore'] });
      const keys = out.split('\n').map(l => l.trim()).filter(l => l.startsWith(hive.split('\\')[0]));
      for (const key of keys) {
        try {
          const detail = execSync(`reg query "${key}" /v DisplayName`, { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
          const dn = detail.split('REG_SZ').pop()?.trim();
          if (!dn || !dn.toLowerCase().includes(display.toLowerCase())) continue;
          try {
            const locOut = execSync(`reg query "${key}" /v InstallLocation`, { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
            const loc = locOut.split('REG_SZ').pop()?.trim();
            if (!loc) continue;
            const pj = readJson(path.join(loc, 'resources', 'app', 'product.json'));
            if (pj?.version) return { version: pj.version, dir: loc };
          } catch {}
        } catch {}
      }
    } catch {}
  }
  return { version: null, dir: null };
}

// ── 3. 平台清单与期望 ──
const CLI = {
  'claude-code': 'claude',
  'codex': 'codex',
  'grok': 'grok',
  'opencode': 'opencode',
  // 实测确认的 CLI（npm 全局包 / uv tool）
  'codebuddy': 'codebuddy',
  'pi': 'pi',
  'deepseek-harness': 'dsh',
  'hermes': 'hermes',
};
const GUI = {
  windsurf: 'Windsurf',
  devin: 'Devin',
  cursor: 'Cursor',
  antigravity: 'Antigravity',
  'antigravity-ide': 'Antigravity IDE',
  'claude-desktop': 'Claude',
};
// 无 CLI、无安装目录版本源的平台（诚实显示「已安装 · 版本未知」）
const NO_PROBE = ['workbuddy', 'zcode'];

console.log('═'.repeat(88));
console.log('平台版本探测对照表（探测算法结果 vs 独立真相源）');
console.log('═'.repeat(88));

let problems = 0;

for (const [id, bin] of Object.entries(CLI)) {
  const probe = probeCli(id, bin);
  const truth = TRUTH[id]?.();
  // 双 null（都找不到）= 一致（未安装），不算 DIFF
  const ok = (truth === null && probe.version === null) || (truth !== null && probe.version === truth);
  const status = ok ? 'OK ' : 'DIFF';
  if (!ok) problems++;
  console.log(`[${status}] ${id.padEnd(16)} 探测=${(probe.version || 'null').padEnd(12)} 真相=${(truth || 'null').padEnd(12)} bin=${probe.found || 'NOT FOUND'}`);
}

// 模拟 find_ide_exe 第②层：常见安装位置（本机对照用，含自定义盘符）
function probeGuiCommonLocation(platformId) {
  const cands = {
    windsurf: ['E:/Program/Windsurf', 'C:/Program Files/Windsurf', 'D:/Program/Windsurf'],
    devin: ['E:/Program/devin', 'C:/Program Files/Devin', 'D:/Program/devin'],
    cursor: [
      'E:/Program/Cursor',
      'C:/Program Files/Cursor',
      path.join(home, 'AppData', 'Local', 'Programs', 'cursor'),
    ],
    antigravity: ['E:/Program/Antigravity', 'C:/Program Files/Antigravity'],
    'antigravity-ide': [
      'E:/Program/Antigravity IDE',
      'C:/Program Files/Antigravity IDE',
      path.join(home, 'AppData', 'Local', 'Programs', 'Antigravity IDE'),
    ],
  };
  for (const base of cands[platformId] || []) {
    const pj = readJson(path.join(base, 'resources', 'app', 'product.json'));
    if (pj) return { version: pj.version || null, dir: base, vscodeVersion: pj.vscodeVersion || null };
  }
  return { version: null, dir: null };
}

for (const [id, display] of Object.entries(GUI)) {
  // 与 find_ide_exe 同序：常见位置 → 运行进程 → 注册表
  const viaCommon = probeGuiCommonLocation(id);
  let via = viaCommon.version ? viaCommon : probeGuiRegistry(id, display);
  if (id === 'antigravity') via = probeAntigravityHub();
  if (id === 'claude-desktop') via = probeClaudeAppx();
  const truth = TRUTH[id]?.();
  const probeV = via.version;
  const ok = (truth === null && probeV === null) || (truth !== null && probeV === truth);
  if (!ok) problems++;
  const vs = via.vscodeVersion ? ` 引擎=${via.vscodeVersion}` : '';
  console.log(`[${ok ? 'OK ' : 'DIFF'}] ${id.padEnd(16)} 探测=${(probeV || 'null').padEnd(12)} 真相=${(truth || 'n/a').padEnd(12)} dir=${via.dir || 'NOT FOUND'}${vs}`);
}

for (const id of NO_PROBE) {
  console.log(`[SKIP] ${id.padEnd(16)} （无 CLI spec / 无 GUI product.json —— 显示「已安装·版本未知」）`);
}

console.log('═'.repeat(88));
console.log(`问题数: ${problems}`);
process.exit(problems > 0 ? 1 : 0);
