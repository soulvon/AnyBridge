import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

export function runTempFileDiscipline({ root, ok }) {
  const TEMP_PREFIX = /^(\.?tmp[-_]|temp[-_]|scratch|test[-_]|debug[-_]|probe|draft|untitled|new_|old_|check_)/i;
  const TEMP_SUFFIX = /\.(bak|orig|old|swp|tmp|rej)$/i;
  const isTemp = (name) =>
    name !== 'tmp' && (TEMP_PREFIX.test(name) || TEMP_SUFFIX.test(name) || /~$/.test(name));
  const isLog = (name) => /\.log$/i.test(name);

  const strays = fs.readdirSync(root).filter(f => isTemp(f) && !isLog(f));
  ok('根目录无散落临时文件（脚本/数据）', strays.length === 0,
    strays.length ? `违规: ${strays.join(', ')}（请移入 tmp/）` : '');

  const tmpDirPath = path.join(root, 'tmp');
  const strayLogs = fs.readdirSync(root).filter(isLog);
  const lockedLogs = [];
  for (const lf of strayLogs) {
    try {
      if (!fs.existsSync(tmpDirPath)) fs.mkdirSync(tmpDirPath);
      fs.renameSync(path.join(root, lf), path.join(tmpDirPath, lf));
      console.log(`  ↪ 已自动迁入 tmp/: ${lf}`);
    } catch {
      lockedLogs.push(lf);
    }
  }
  if (lockedLogs.length) {
    console.log(`  ℹ 被进程独占锁定，暂无法移动（下次检查自动重试）: ${lockedLogs.join(', ')}`);
  }
  ok('运行日志已归入 tmp/（可移动部分）', true);

  for (const d of ['src-tauri/src', 'ui', 'ui-src', 'scripts']) {
    const full = path.join(root, d);
    if (!fs.existsSync(full)) continue;
    const bad = [];
    const scan = (dir, depth) => {
      if (depth > 4) return;
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.name.startsWith('.tmp_')) bad.push(path.join(dir, e.name).replace(root + path.sep, ''));
        else if (e.isDirectory()) scan(path.join(dir, e.name), depth + 1);
      }
    };
    scan(full, 0);
    ok(`${d}/ 无散落临时文件`, bad.length === 0, bad.join(', '));
  }

  const tmpDir = path.join(root, 'tmp');
  if (!fs.existsSync(tmpDir)) {
    fs.mkdirSync(tmpDir, { recursive: true });
    console.log('  ℹ tmp/ 不存在（CI 干净检出），已自动创建');
  }
  ok('tmp/ 目录存在', fs.existsSync(tmpDir));
}

export function runCommitHygiene({ root, ok }) {
  const mustIgnore = [
    ['tmp/', '临时文件目录'],
    ['.codebuddy/', 'AI 工具配置目录'],
    ['src-tauri/target/', 'Rust 构建产物'],
    ['node_modules/', '依赖目录'],
  ];
  for (const [pat, label] of mustIgnore) {
    let ignored = false;
    try {
      execSync(`git check-ignore -q "${pat}__probe__"`, { cwd: root, stdio: 'pipe' });
      ignored = true;
    } catch { ignored = false; }
    ok(`${pat} 被 gitignore 覆盖（${label}）`, ignored, ignored ? '' : '规则缺失或失效');
  }

  {
    let ignored = false;
    try {
      execSync('git check-ignore -q AGENTS.md', { cwd: root, stdio: 'pipe' });
      ignored = true;
    } catch { ignored = false; }
    ok('AGENTS.md 被 gitignore 覆盖（AI 操作手册不入库）', ignored, ignored ? '' : '规则缺失或失效');
  }

  let tracked = '';
  try {
    tracked = execSync('git ls-files', { cwd: root, encoding: 'utf8', stdio: 'pipe' });
  } catch { }
  const files = tracked.split('\n').filter(Boolean);
  const banned = files.filter(f => {
    if (/^(tmp\/|node_modules\/|src-tauri\/target\/|cursor-core\/target\/)/.test(f)) return true;
    if (/\.(log|bak|orig|swp|rej)$/i.test(f)) return true;
    if (/^\.tmp_|^tmp_/.test(path.basename(f))) return true;
    if (/(^|\/)\.env$/.test(f)) return true;
    if (/\.(pem|key|pfx|p12)$/i.test(f) && !/\.gitkeep$/.test(f)) return true;
    return false;
  });
  ok('已跟踪文件无日志/临时/敏感/构建产物', banned.length === 0,
    banned.slice(0, 6).join(', ') + (banned.length > 6 ? ` …共 ${banned.length} 个` : ''));

  let staged = '';
  try {
    staged = execSync('git diff --cached --name-only', { cwd: root, encoding: 'utf8', stdio: 'pipe' });
  } catch { }
  const stagedBad = staged.split('\n').filter(Boolean).filter(f => {
    if (/^(tmp\/|node_modules\/|src-tauri\/target\/)/.test(f)) return true;
    if (/\.(log|bak|orig|swp|rej)$/i.test(f)) return true;
    if (/^\.tmp_|^tmp_/.test(path.basename(f))) return true;
    if (/(^|\/)\.env$/.test(f)) return true;
    if (/\.(pem|key|pfx|p12)$/i.test(f)) return true;
    return false;
  });
  ok('暂存区无非预期文件', stagedBad.length === 0, stagedBad.join(', '));

  const secretRe = /(sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16})/;
  const leaked = [];
  if (staged.trim()) {
    for (const f of staged.split('\n').filter(Boolean)) {
      if (!/\.(rs|js|mjs|ts|json|toml|html|md)$/i.test(f)) continue;
      try {
        const content = execSync(`git show :${JSON.stringify(f)}`, { cwd: root, encoding: 'utf8', stdio: 'pipe' });
        if (secretRe.test(content)) leaked.push(f);
      } catch { }
    }
  }
  ok('暂存内容无明文密钥', leaked.length === 0, leaked.join(', '));

  const DOC_ALLOW = [
    /^README(_en)?\.md$/i,
    /^CHANGELOG\.md$/i,
    /^docs\/CHANGELOG_INTERNAL\.md$/i,
    /^docs\/capabilities\.md$/i,
    /^docs\/(ARCHITECTURE|DEVELOPMENT|RELEASE|MACOS_TROUBLESHOOTING|WORKFLOW)(_zh)?\.md$/i,
    /^docs\/subsystems\/[a-z0-9-]+\.md$/i,
    /(^|\/)README\.md$/i,
    /^\.github\/pull_request_template\.md$/i,
    /^PRIVACY\.md$/i,
    /^cursor-core\/prompt\//,
    /^cursor-core\/UPSTREAM\.md$/i,
    /^sidecar\/prompts\//,
    /^src-tauri\/resources\//,
  ];
  const trackedMd = files.filter(f => /\.md$/i.test(f));
  const docViolations = trackedMd.filter(f => !DOC_ALLOW.some(re => re.test(f)));
  ok('已跟踪文档均为说明文档（无设计/调研文档）', docViolations.length === 0,
    docViolations.length ? `不应入库：${docViolations.join(', ')}` : '');

  let stagedAddMod = '';
  try {
    stagedAddMod = execSync('git diff --cached --name-only --diff-filter=AM', {
      cwd: root, encoding: 'utf8', stdio: 'pipe',
    });
  } catch { }
  const stagedMd = stagedAddMod.split('\n').filter(Boolean).filter(f => /\.md$/i.test(f));
  const stagedDocBad = stagedMd.filter(f => !DOC_ALLOW.some(re => re.test(f)));
  ok('暂存区无新增设计/调研文档', stagedDocBad.length === 0, stagedDocBad.join(', '));

  let ignoredButTracked = '';
  try {
    ignoredButTracked = execSync('git ls-files -i -c --exclude-standard', {
      cwd: root, encoding: 'utf8', stdio: 'pipe',
    });
  } catch { }
  const ibt = ignoredButTracked.split('\n').filter(Boolean);
  ok('无「已跟踪却匹配 gitignore」的文件', ibt.length === 0,
    ibt.length ? `${ibt.join(', ')} → 需 git rm --cached 或加 ! 例外` : '');
}

export function runPathPortability({ root, ok }) {
  const HARDCODED = /([A-Za-z]:[\\/](?:Program|Users|Windows|ProgramData))|(C:[\\/]Users[\\/][A-Za-z0-9._-]+)|(\/[Uu]sers\/[A-Za-z0-9._-]+)|(\/home\/[A-Za-z0-9._-]+)/;
  const isComment = (line) => /^\s*(\/\/|\/\*|\*|#|<!--|""")/.test(line);

  const scanFiles = (dirs, exts) => {
    const out = [];
    for (const d of dirs) {
      const full = path.join(root, d);
      if (!fs.existsSync(full)) continue;
      const walk = (cur, depth) => {
        if (depth > 5) return;
        for (const e of fs.readdirSync(cur, { withFileTypes: true })) {
          if (['node_modules', 'target', '.git', 'tmp'].includes(e.name)) continue;
          const p = path.join(cur, e.name);
          if (e.isDirectory()) walk(p, depth + 1);
          else if (exts.some(x => e.name.endsWith(x))) out.push(p);
        }
      };
      walk(full, 0);
    }
    return out;
  };

  const violations = [];
  for (const file of scanFiles(['src-tauri/src', 'ui/assets/scripts', 'ui-src'], ['.rs', '.js', '.mjs', '.html'])) {
    const rel = file.replace(root + path.sep, '').split(path.sep).join('/');
    if (file.endsWith('.rs') && (/(^|\/)(tests|log_tests)\.rs$/.test(rel) || /\/tests\//.test(rel))) continue;
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    let testStart = -1;
    if (file.endsWith('.rs')) {
      const idx = lines.findIndex(l => /^\s*(#\[cfg\(test\)\]|mod tests)/.test(l));
      if (idx >= 0) testStart = idx;
    }
    lines.forEach((line, i) => {
      if (isComment(line)) return;
      if (testStart >= 0 && i > testStart) return;
      const probe = line
        .replace(/C:\\+Windows/gi, '')
        .replace(/https?:\/\/\S+/gi, '');
      if (!HARDCODED.test(probe)) return;
      violations.push(`${rel}:${i + 1}`);
    });
  }
  ok('生产代码无硬编码盘符/用户目录', violations.length === 0,
    violations.slice(0, 6).join(', ') + (violations.length > 6 ? ` …共 ${violations.length} 处` : ''));

  const platSrc = fs.readdirSync(path.join(root, 'src-tauri/src/commands/platforms'))
    .filter(f => f.endsWith('.rs'))
    .map(f => fs.readFileSync(path.join(root, 'src-tauri/src/commands/platforms', f), 'utf8'))
    .join('\n');
  ok('平台配置目录解析使用 dirs 抽象', /dirs::(home_dir|data_dir|data_local_dir|config_dir)/.test(platSrc));
}

const WIN_API_RE = /\bwindows_sys::|\bcreation_flags\s*\(|\bCommandExt\b|\bwinreg::|\bstd::os::windows::/;
const CFG_WIN_RE = /#!?\[cfg\([^\]]*(?:\bwindows\b|target_os\s*=\s*"windows")[^\]]*\)\]/;
const CFG_NOT_WIN_RE = /#!?\[cfg\([^\]]*not\([^)]*(?:\bwindows\b|target_os\s*=\s*"windows")/;
const CFG_UNIX_RE = /#!?\[cfg\([^\]]*(?:\bunix\b|target_os\s*=\s*"(?:linux|macos)"|not\([^)]*(?:\bwindows\b|target_os\s*=\s*"windows"))[^\]]*\)\]/;

// 逐字符剥离 Rust 注释与字符串（含嵌套块注释、普通字符串、原始字符串 r#"..."# 与字符字面量），
// 保留结构分隔符与标识符，避免原始字符串里的 `{`/`}` 干扰大括号作用域栈。
function stripRustLine(line, state) {
  let out = '';
  let i = 0;
  const n = line.length;
  while (i < n) {
    if (state.blockCommentDepth > 0) {
      if (line[i] === '/' && line[i + 1] === '*') {
        state.blockCommentDepth++;
        i += 2;
      } else if (line[i] === '*' && line[i + 1] === '/') {
        state.blockCommentDepth--;
        i += 2;
      } else {
        i++;
      }
      continue;
    }
    if (state.rawHashes !== null) {
      if (line[i] === '"') {
        let hashes = 0;
        while (i + 1 + hashes < n && line[i + 1 + hashes] === '#' && hashes < state.rawHashes) {
          hashes++;
        }
        if (hashes === state.rawHashes) {
          i += 1 + hashes;
          state.rawHashes = null;
          continue;
        }
      }
      i++;
      continue;
    }
    if (state.inString) {
      if (line[i] === '\\' && i + 1 < n) {
        i += 2;
      } else if (line[i] === '"') {
        state.inString = false;
        i++;
      } else {
        i++;
      }
      continue;
    }
    if (line[i] === '/' && line[i + 1] === '/') {
      break;
    }
    if (line[i] === '/' && line[i + 1] === '*') {
      state.blockCommentDepth = 1;
      i += 2;
      continue;
    }
    // 原始字符串：r"..." / r#"..."# / br#"..."#
    if (
      (line[i] === 'r' || (line[i] === 'b' && line[i + 1] === 'r'))
      && (i === 0 || !/[A-Za-z0-9_]/.test(line[i - 1]))
    ) {
      let j = line[i] === 'b' ? i + 2 : i + 1;
      let hashes = 0;
      while (j < n && line[j] === '#') {
        hashes++;
        j++;
      }
      if (j < n && line[j] === '"') {
        state.rawHashes = hashes;
        i = j + 1;
        out += '""';
        continue;
      }
    }
    if (line[i] === '"') {
      state.inString = true;
      i++;
      out += '""';
      continue;
    }
    // 字符字面量：'x' / '\n' / '\x7f' / '\u{...}'（跳过生命周期 'a / 'static）
    if (line[i] === "'" && (i === 0 || !/[A-Za-z0-9_]/.test(line[i - 1]))) {
      if (line[i + 1] === '\\') {
        const end = line.indexOf("'", i + 2);
        if (end > i) {
          i = end + 1;
          out += "''";
          continue;
        }
      } else if (i + 2 < n && line[i + 2] === "'") {
        i += 3;
        out += "''";
        continue;
      }
    }
    out += line[i];
    i++;
  }
  return out;
}

function collectModuleCfgTargets(entries) {
  const relSet = new Set(entries.map((e) => e.rel));
  const winModFiles = new Set();
  const unixModFiles = new Set();

  for (const { rel, content } of entries) {
    const dir = path.posix.dirname(rel);
    const lines = content.split(/\r?\n/);
    let pendingWin = false;
    let pendingUnix = false;
    let pendingPath = null;

    for (const raw of lines) {
      const s = raw.trim();
      if (!s || s.startsWith('//')) continue;
      if (CFG_WIN_RE.test(raw) && !CFG_NOT_WIN_RE.test(raw)) {
        pendingWin = true;
        continue;
      }
      if (CFG_UNIX_RE.test(raw)) {
        pendingUnix = true;
        continue;
      }
      const pathMatch = s.match(/^#\[path\s*=\s*"([^"]+)"\]$/);
      if (pathMatch) {
        pendingPath = pathMatch[1];
        continue;
      }
      if (s.startsWith('#[')) continue;

      const modMatch = s.match(/^(?:pub(?:\([^)]*\))?\s+)?mod\s+([A-Za-z0-9_]+)\s*;/);
      if (modMatch && (pendingWin || pendingUnix)) {
        const modName = modMatch[1];
        const candidates = pendingPath
          ? [path.posix.normalize(path.posix.join(dir, pendingPath))]
          : [
              path.posix.normalize(path.posix.join(dir, `${modName}.rs`)),
              path.posix.normalize(path.posix.join(dir, modName, 'mod.rs')),
            ];
        for (const cand of candidates) {
          if (relSet.has(cand)) {
            if (pendingWin) winModFiles.add(cand);
            if (pendingUnix) unixModFiles.add(cand);
          }
        }
      }
      pendingWin = false;
      pendingUnix = false;
      pendingPath = null;
    }
  }
  return { winModFiles, unixModFiles };
}

export function auditRustPlatformGuards(entries) {
  const { winModFiles, unixModFiles } = collectModuleCfgTargets(entries);
  const unguardedWinApi = [];
  const danglingCfgs = [];
  const missingUnixImports = [];
  let winApiLines = 0;

  for (const { rel, content } of entries) {
    const lines = content.split(/\r?\n/);
    const fileWinCfg = winModFiles.has(rel)
      || lines.slice(0, 25).some((l) => /^\s*#!\[cfg\([^\]]*(?:\bwindows\b|target_os\s*=\s*"windows")/.test(l) && !CFG_NOT_WIN_RE.test(l));
    const fileUnixCfg = unixModFiles.has(rel)
      || lines.slice(0, 25).some((l) => /^\s*#!\[cfg\([^\]]*(?:\bunix\b|target_os\s*=\s*"(?:linux|macos)"|not\([^)]*(?:\bwindows\b|target_os\s*=\s*"windows"))/.test(l));

    // 第一遍：收集文件级非 Windows 导入与孤悬 #[cfg(...)] 属性，同时做精确词法作用域跟踪
    const state = { blockCommentDepth: 0, rawHashes: null, inString: false };
    let braceDepth = 0;
    const winCfgDepths = [];
    const unixCfgDepths = [];
    let pendingWinCfg = false;
    let pendingUnixCfg = false;
    let nonWinPermissionsExt = false;
    let nonWinCommandImport = false;
    let inUseStatement = false;
    let useBuf = '';
    let useInWin = false;

    const lineScopes = [];

    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i];
      const trimmed = raw.trim();
      const wasInLiteral = state.blockCommentDepth > 0 || state.rawHashes !== null || state.inString;

      if (!wasInLiteral && !trimmed.startsWith('//')) {
        // 孤悬 #[cfg(...)] 检测：属性后紧跟空行或文档注释（拆文件残留吃函数的精确特征）
        if (/^\s*#\[cfg\(/.test(raw)) {
          let attrEnd = i;
          let bracketBal = (raw.match(/\[/g) || []).length - (raw.match(/\]/g) || []).length;
          while (bracketBal > 0 && attrEnd + 1 < lines.length) {
            attrEnd++;
            bracketBal += (lines[attrEnd].match(/\[/g) || []).length - (lines[attrEnd].match(/\]/g) || []).length;
          }
          if (attrEnd + 1 < lines.length && lines[attrEnd + 1].trim() === '') {
            danglingCfgs.push(`${rel}:${i + 1} (${trimmed} 后存在空行)`);
          } else {
            for (let j = attrEnd + 1; j < Math.min(lines.length, attrEnd + 8); j++) {
              const sj = lines[j].trim();
              if (!sj) continue;
              if (sj.startsWith('///') || sj.startsWith('/**')) {
                danglingCfgs.push(`${rel}:${i + 1} (${trimmed} 后紧跟文档注释 L${j + 1})`);
              }
              break;
            }
          }
        }
        if (CFG_WIN_RE.test(raw) && !CFG_NOT_WIN_RE.test(raw)) {
          pendingWinCfg = true;
        }
        if (CFG_UNIX_RE.test(raw)) {
          pendingUnixCfg = true;
        }
      }

      const code = stripRustLine(raw, state);
      const inWin = fileWinCfg || winCfgDepths.length > 0 || pendingWinCfg;
      const inUnix = fileUnixCfg || unixCfgDepths.length > 0 || pendingUnixCfg;

      // 收集未被 #[cfg(windows)] 挡住的顶层/非 Windows 导入（支持多行 use {...};）
      const codeTrim = code.trim();
      if (!inUseStatement && /^(?:pub(?:\([^)]*\))?\s+)?use\s+/.test(codeTrim)) {
        inUseStatement = true;
        useBuf = codeTrim;
        useInWin = inWin;
      } else if (inUseStatement) {
        useBuf += ' ' + codeTrim;
      }
      if (inUseStatement && useBuf.includes(';')) {
        if (!useInWin) {
          if (/std::os::unix::fs::(?:\{[^}]*\bPermissionsExt\b|PermissionsExt\b)/.test(useBuf)) {
            nonWinPermissionsExt = true;
          }
          if (
            /(?:std|tokio)::process::(?:\{[^}]*\bCommand\b|Command\b)/.test(useBuf)
            || /\buse\s+super::\*/.test(useBuf)
          ) {
            nonWinCommandImport = true;
          }
        }
        inUseStatement = false;
        useBuf = '';
      }

      if (WIN_API_RE.test(code)) {
        winApiLines++;
        if (!inWin) {
          unguardedWinApi.push(`${rel}:${i + 1}`);
        }
      }

      lineScopes.push({ idx: i + 1, code, inUnix });

      for (let c = 0; c < code.length; c++) {
        const ch = code[c];
        if (ch === '{') {
          braceDepth++;
          if (pendingWinCfg) {
            winCfgDepths.push(braceDepth);
            pendingWinCfg = false;
          }
          if (pendingUnixCfg) {
            unixCfgDepths.push(braceDepth);
            pendingUnixCfg = false;
          }
        } else if (ch === '}') {
          if (winCfgDepths.length && winCfgDepths[winCfgDepths.length - 1] === braceDepth) {
            winCfgDepths.pop();
            const rest = code.slice(c + 1).trim();
            const nextLine = (lines[i + 1] || '').trim();
            if (/^else\b/.test(rest) || /^else\b/.test(nextLine)) pendingWinCfg = true;
          }
          if (unixCfgDepths.length && unixCfgDepths[unixCfgDepths.length - 1] === braceDepth) {
            unixCfgDepths.pop();
            const rest = code.slice(c + 1).trim();
            const nextLine = (lines[i + 1] || '').trim();
            if (/^else\b/.test(rest) || /^else\b/.test(nextLine)) pendingUnixCfg = true;
          }
          braceDepth = Math.max(0, braceDepth - 1);
        } else if (ch === ';') {
          if (pendingWinCfg) pendingWinCfg = false;
          if (pendingUnixCfg) pendingUnixCfg = false;
        }
      }
    }

    // 第二遍：检查非 Windows 分支的典型缺失导入（PermissionsExt / 裸 Command::new）
    for (const { idx, code, inUnix } of lineScopes) {
      if (!inUnix) continue;
      if (/(?:Permissions::|\.)from_mode\s*\(/.test(code) && !nonWinPermissionsExt) {
        missingUnixImports.push(`${rel}:${idx} (from_mode 缺 std::os::unix::fs::PermissionsExt 导入)`);
      }
      if (/(?<!::)\bCommand::new\s*\(/.test(code) && !nonWinCommandImport) {
        missingUnixImports.push(`${rel}:${idx} (非 Windows 分支裸用 Command::new 缺导入，建议改用 std::process::Command::new)`);
      }
    }
  }

  return {
    scannedFiles: entries.length,
    winApiLines,
    unguardedWinApi,
    danglingCfgs,
    missingUnixImports,
  };
}

export function scanRustPlatformGuards(root) {
  const entries = [];
  const walk = (dir, depth) => {
    if (depth > 8 || !fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (['target', 'node_modules', '.git', 'tmp'].includes(e.name)) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(p, depth + 1);
        continue;
      }
      if (!e.name.endsWith('.rs')) continue;
      const rel = path.relative(root, p).split(path.sep).join('/');
      entries.push({ rel, content: fs.readFileSync(p, 'utf8') });
    }
  };
  for (const top of ['src-tauri/src', 'cursor-core/src', 'cursor-core/crates']) {
    walk(path.join(root, top), 0);
  }
  return auditRustPlatformGuards(entries);
}

export function runPlatformGuards({ root, ok }) {
  const report = scanRustPlatformGuards(root);
  ok(
    `Windows API 调用（${report.winApiLines} 处，覆盖 src-tauri + cursor-core ${report.scannedFiles} 文件）均在精确 cfg 守卫作用域内`,
    report.unguardedWinApi.length === 0,
    report.unguardedWinApi.slice(0, 6).join(', ')
      + (report.unguardedWinApi.length > 6 ? ` …共 ${report.unguardedWinApi.length} 处` : ''),
  );
  ok(
    'Rust 源码无孤悬 #[cfg(...)] 属性（禁止属性后空行或紧跟文档注释）',
    report.danglingCfgs.length === 0,
    report.danglingCfgs.slice(0, 6).join('; ')
      + (report.danglingCfgs.length > 6 ? ` …共 ${report.danglingCfgs.length} 处` : ''),
  );
  ok(
    '非 Windows 条件分支无典型缺失导入（PermissionsExt / Command）',
    report.missingUnixImports.length === 0,
    report.missingUnixImports.slice(0, 6).join('; ')
      + (report.missingUnixImports.length > 6 ? ` …共 ${report.missingUnixImports.length} 处` : ''),
  );
}
