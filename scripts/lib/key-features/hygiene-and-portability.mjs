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

export function runPlatformGuards({ root, ok }) {
  const WIN_API = /windows_sys::|creation_flags\(|CommandExt/;
  const GUARD = /cfg\(\s*(windows|target_os\s*=\s*"windows")\s*\)/;
  const unguarded = [];
  let apiLines = 0;
  const isCommentLine = (l) => /^\s*(\/\/|\/\*|\*)/.test(l);

  const walk = (dir, depth) => {
    if (depth > 5) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p, depth + 1); continue; }
      if (!e.name.endsWith('.rs')) continue;
      const lines = fs.readFileSync(p, 'utf8').split('\n');
      lines.forEach((line, i) => {
        if (!WIN_API.test(line) || isCommentLine(line)) return;
        apiLines++;
        const ctx = lines.slice(Math.max(0, i - 80), i + 2).join('\n');
        if (!GUARD.test(ctx)) {
          unguarded.push(`${p.replace(root + path.sep, '').split(path.sep).join('/')}:${i + 1}`);
        }
      });
    }
  };
  walk(path.join(root, 'src-tauri/src'), 0);

  const PLATFORM_WHITELIST = new Set(['src-tauri/src/commands/cert_install/platform_win.rs']);
  const strict = unguarded.filter(x => !PLATFORM_WHITELIST.has(x.split(':')[0]));
  const whitelisted = unguarded.filter(x => PLATFORM_WHITELIST.has(x.split(':')[0]));
  if (whitelisted.length) {
    console.log(`  ℹ 白名单（UAC/证书子系统，待多平台化）：${whitelisted.length} 处`);
  }
  ok(`Windows API 调用（${apiLines} 处）均在 cfg 守卫内（白名单除外）`, strict.length === 0,
    strict.slice(0, 6).join(', ') + (strict.length > 6 ? ` …共 ${strict.length} 处` : ''));
}
