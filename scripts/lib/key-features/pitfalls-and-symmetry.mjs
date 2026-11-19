import fs from 'node:fs';
import path from 'node:path';

export function printStartupManifest({ root }) {
  const pfPath = path.join(root, 'docs', 'pitfalls.json');
  if (fs.existsSync(pfPath)) {
    const pf = JSON.parse(fs.readFileSync(pfPath, 'utf8'));
    console.log(`📌 已知坑点 ${pf.pitfalls.length} 条（改动前必读 docs/pitfalls.json）：`);
    pf.pitfalls.forEach((p, i) => {
      console.log(`   ${String(i + 1).padStart(2)}. [${p.severity}] ${p.title}`);
    });
    console.log('');
  }
  const capPath = path.join(root, 'docs', 'capabilities.md');
  if (fs.existsSync(capPath)) {
    console.log('🛡️ 核心能力清单（改动前必查 docs/capabilities.md，严禁重复造轮子）：');
    const capContent = fs.readFileSync(capPath, 'utf8');
    const matches = capContent.matchAll(/\|\s*\*\*([^*]+)\*\*\s*\|\s*`([^`]+)`/g);
    let idx = 1;
    for (const m of matches) {
      console.log(`   ${String(idx++).padStart(2)}. ${m[1]} → ${m[2]}`);
    }
    console.log('');
  }
}

export function runPitfallsCheck({ root, ok }) {
  const pfPath = path.join(root, 'docs', 'pitfalls.json');
  if (!fs.existsSync(pfPath)) {
    ok('坑点库存在', false, 'docs/pitfalls.json 缺失');
    return;
  }
  const pf = JSON.parse(fs.readFileSync(pfPath, 'utf8'));
  ok(`坑点库已加载（${pf.pitfalls.length} 条）`, true);
  for (const p of pf.pitfalls) {
    const c = p.check;
    if (!c) { ok(`[${p.id}] 有判据`, false); continue; }
    const targetFiles = Array.isArray(c.files) && c.files.length ? c.files : [c.file];
    const missingFile = targetFiles.find(f => !fs.existsSync(path.join(root, f)));
    if (missingFile) { ok(`[${p.id}] ${missingFile} 存在`, false); continue; }
    const sources = targetFiles.map(f => fs.readFileSync(path.join(root, f), 'utf8'));
    let pass = false;
    if (c.type === 'source_contains') pass = sources.some(src => src.includes(c.must_contain));
    else if (c.type === 'source_not_regex') {
      const re = new RegExp(c.must_not_match);
      pass = sources.every(src => !re.test(src));
    }
    ok(`[${p.id}] ${p.title}`, pass, pass ? '' : `判据未满足（${c.type}）`);
    if (pass && p.check_not) {
      const n = p.check_not;
      const nf = path.join(root, n.file);
      if (fs.existsSync(nf)) {
        const nsrc = fs.readFileSync(nf, 'utf8');
        const okNot = !new RegExp(n.must_not_match).test(nsrc);
        ok(`[${p.id}] 反向判据（不得回退）`, okNot);
      }
    }
    if (p.regression_test) {
      const [refFile, ...refParts] = p.regression_test.split('::');
      const refPath = path.join(root, refFile);
      const refName = refParts.join('::');
      const refExists = fs.existsSync(refPath);
      const refSource = refExists ? fs.readFileSync(refPath, 'utf8') : '';
      ok(`[${p.id}] 行为测试引用未漂移`, refExists && refSource.includes(refName),
        refExists ? `未找到: ${refName}` : `${refFile} 不存在`);
    }
  }
}

export function runSymmetryChecks({ root, ok }) {
  const cmds = [];
  const walkCommands = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (ent.name !== 'tests') walkCommands(p);
      } else if (ent.name.endsWith('.rs')) {
        const src = fs.readFileSync(p, 'utf8');
        const re = /#\[tauri::command\]\s*(?:pub\s+)?(async\s+)?fn\s+(\w+)/g;
        let m;
        while ((m = re.exec(src))) cmds.push({ name: m[2], async: !!m[1] });
      }
    }
  };
  walkCommands(path.join(root, 'src-tauri/src/commands'));
  const byName = new Map(cmds.map(c => [c.name, c]));
  const asym = [];
  for (const c of cmds) {
    if (!/^(apply|restore)_/.test(c.name)) continue;
    const paired = c.name.replace(/^(apply|restore)_/, (_, k) => (k === 'apply' ? 'restore_' : 'apply_'));
    const other = byName.get(paired);
    if (other && other.async !== c.async) {
      asym.push(`${c.name}(${c.async ? 'async' : 'sync'}) ↔ ${other.name}(${other.async ? 'async' : 'sync'})`);
    }
  }
  ok('apply/restore 命令对异步化一致', asym.length === 0, asym.join('; '));

  const pf = fs.readFileSync(path.join(root, 'src-tauri/src/commands/platforms/antigravity.rs'), 'utf8');
  const killCalls = (pf.match(/Self::kill_antigravity_language_server\(\)/g) || []).length;
  ok('Antigravity 接入+还原都调用同一 kill 实现', killCalls >= 2, `调用点 ${killCalls} 处（应≥2）`);

  const cursorAccount = fs.readFileSync(path.join(root, 'cursor-core/src/local_app/account.rs'), 'utf8');
  const cursorAuthSrc = fs.readFileSync(path.join(root, 'src-tauri/src/commands/cursor_auth.rs'), 'utf8');
  const cursorLocalApp = fs.readFileSync(path.join(root, 'cursor-core/src/local_app/mod.rs'), 'utf8');
  const LEDGER_FILE = 'cursor-auth-backup.json';
  ok('Cursor 账号账本两侧同名', cursorAccount.includes(LEDGER_FILE) && cursorAuthSrc.includes(LEDGER_FILE));
  ok('Cursor 关闭接管时调用账号还原', cursorLocalApp.includes('account::restore_if_backed_up'));
  const ledgerWriteAt = cursorAccount.indexOf('write_ledger(ledger');
  const accountWriteAt = cursorAccount.indexOf('INSERT OR REPLACE INTO ItemTable');
  ok(
    'Cursor 注入覆盖前先落账本',
    ledgerWriteAt >= 0 && accountWriteAt > ledgerWriteAt,
    ledgerWriteAt < 0 ? '未找到 write_ledger 调用' : `write_ledger@${ledgerWriteAt} / 首次写库@${accountWriteAt}`,
  );
  ok(
    'Cursor 本地账号标识两侧一致',
    cursorAccount.includes('cursor@ai.com') && cursorAuthSrc.includes('cursor@ai.com'),
  );
  const ideConfigSrc = fs.readFileSync(path.join(root, 'src-tauri/src/commands/ide_config/mod.rs'), 'utf8');
  ok(
    'Cursor proxySupport 不得写回 on（必须 override）',
    !/PROXY_SUPPORT_KEY\.into\(\),\s*Value::String\("on"/.test(ideConfigSrc),
  );
}
