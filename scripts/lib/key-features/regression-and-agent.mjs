import fs from 'node:fs';
import path from 'node:path';

export function runAgentSpecChecks({ root, ok }) {
  const specPath = path.join(root, 'src-tauri/src/commands/agent_spec/mod.rs');
  const specsDataPath = path.join(root, 'src-tauri/src/commands/agent_spec/specs.rs');
  ok('AgentSpec 声明模块存在', fs.existsSync(specPath) && fs.existsSync(specsDataPath));
  if (!fs.existsSync(specPath) || !fs.existsSync(specsDataPath)) return;

  const src = fs.readFileSync(specsDataPath, 'utf8');
  ok('声明表 AGENTS 存在', /pub static AGENTS: &\[AgentSpec\]/.test(src));

  const ids = [...src.matchAll(/\n\s+id: "([a-z0-9-]+)"/g)].map(m => m[1]);
  const uniq = new Set(ids);
  ok('声明 id 唯一', ids.length === uniq.size,
    ids.length !== uniq.size ? '存在重复 id' : '');
  ok('内置平台声明齐全（≥13）', ids.length >= 13, `实际 ${ids.length}`);

  const blocks = src.split('AgentSpec {').slice(1).filter(b => /\n\s+id: "/.test(b));
  const incomplete = blocks.filter(
    b => !/family: Family::/.test(b) || !/config_dir: PathSource::/.test(b) || !/config_file: FileSource::/.test(b) || !/api_format: "/.test(b),
  );
  ok('每条声明字段完整（family/config_dir/config_file/api_format）', incomplete.length === 0,
    incomplete.length ? `${incomplete.length} 条不完整` : '');

  ok('扩展脚手架 scripts/new-agent.mjs 存在', fs.existsSync(path.join(root, 'scripts/new-agent.mjs')));
}

export function runRegressionAssertions({ root, ok }) {
  {
    const locDir = path.join(root, 'src-tauri/src/commands/app_localization');
    const s = fs.readdirSync(locDir)
      .filter(f => f.endsWith('.rs') && f !== 'tests.rs')
      .map(f => fs.readFileSync(path.join(locDir, f), 'utf8'))
      .join('\n');
    ok('损坏判据用 is_valid_workbench（结构）而非体积阈值', s.includes('fn is_valid_workbench') && !/MIN_VALID_WORKBENCH_LEN:\s*usize\s*=\s*\d{3,}/.test(s));
    ok('apply 前快照 + 写后校验存在', s.includes('html_snapshot_path') && s.includes('写后校验'));
    ok('语言包三条件判定（目录+废弃标记+注册表）', s.includes('条件 2：不在 .obsolete') && s.includes('条件 3：languagepacks.json'));
    ok('Windsurf/Devin 注入带 CSP nonce', s.includes('extract_csp_nonce') && s.includes('nonce='));
    ok('keeper 不重入死锁（apply_inner）', s.includes('fn apply_inner') && s.includes('apply_inner(platform'));
  }

  {
    const modSrc = fs.readFileSync(path.join(root, 'src-tauri/src/commands/workbench_inject/mod.rs'), 'utf8');
    const testsSrc = fs.readFileSync(path.join(root, 'src-tauri/src/commands/workbench_inject/tests.rs'), 'utf8');
    ok('BYOK 剥离保留汉化块的测试仍在', testsSrc.includes('汉化块必须保留'));
    ok('BYOK 还原是剥离式而非整体覆盖', modSrc.includes('fn strip_byok_block'));
  }

  {
    const s = fs.readFileSync(path.join(root, 'src-tauri/src/commands/platforms/antigravity_patch.rs'), 'utf8');
    ok('BYOK asar 补丁轻量预检（幂等跳过）', s.includes('轻量预检'));
    ok('汉化 asar 补丁构造→比对→按需写回', fs.readFileSync(path.join(root, 'src-tauri/src/commands/antigravity_localization/hub_patch.rs'), 'utf8').includes('if original_code == new_code'));
  }

  {
    const modSrc = fs.readFileSync(path.join(root, 'src-tauri/src/commands/codex_desktop/mod.rs'), 'utf8');
    const launchSrc = fs.readFileSync(path.join(root, 'src-tauri/src/commands/codex_desktop/launch_and_http.rs'), 'utf8');
    const s = `${modSrc}\n${launchSrc}`;
    const implAt = modSrc.indexOf('async fn restart_codex_desktop_impl');
    const guardAt = implAt >= 0 ? modSrc.indexOf('ensure_injection_backend(', implAt) : -1;
    const killAt = implAt >= 0 ? modSrc.indexOf('kill_codex()', implAt) : -1;
    ok('Codex 切换：代理就绪检查先于 kill 客户端',
      implAt >= 0 && guardAt > implAt && killAt > implAt && guardAt < killAt,
      `impl=${implAt} guard=${guardAt} kill=${killAt}`);

    const startAt = modSrc.indexOf('pub async fn start_codex_with_cdp');
    const startGuard = startAt >= 0 ? modSrc.indexOf('ensure_injection_backend(', startAt) : -1;
    ok('Codex 手动启动：同样走代理就绪检查', startGuard > startAt);

    ok('本地 HTTP 探测保留全部地址的失败原因',
      s.includes('fn connect_error') && s.includes('errors.push') && !/last_err\s*=/.test(s));

    const ui = fs.readFileSync(path.join(root, 'ui/assets/scripts/platforms/switch_flow.js'), 'utf8');
    ok('切换失败只把主句上屏，详情进日志',
      ui.includes('function messageHeadline') && ui.includes('function messageDetail') &&
      ui.includes('function switchFlowErrorLog'));
  }

  {
    const cdp = fs.readFileSync(path.join(root, 'sidecar/lib/codex-desktop-cdp.js'), 'utf8');
    ok('CDP 探测同时覆盖 IPv4 与 IPv6 回环',
      cdp.includes('http://127.0.0.1:${port}/json') && cdp.includes('http://[::1]:${port}/json'));
    ok('注入前自证目标是 Codex（拒绝注入别人的页面）', cdp.includes('function isCodexDesktopTarget'));

    const uiSrc = fs.readFileSync(path.join(root, 'ui/assets/scripts/platforms/switch_flow.js'), 'utf8');
    const start = uiSrc.indexOf('function codexApplyConfirmMessage');
    const end = start >= 0 ? uiSrc.indexOf('\n}', start) : -1;
    const confirmSrc = start >= 0 && end > start
      ? uiSrc.slice(start, end).split('\n').filter(l => !l.trim().startsWith('//')).join('\n')
      : '';
    ok('Codex 切换确认文案不暴露实现细节',
      confirmSrc.length > 0 && !/统一桶|CDP 注入|state_5\.sqlite/.test(confirmSrc));
    ok('Codex 切换确认不再重复供应商名', confirmSrc.length > 0 && !confirmSrc.includes('供应商：'));
    ok('切换失败详情不丢（错误聚合保留每个地址）',
      fs.readFileSync(path.join(root, 'src-tauri/src/commands/codex_desktop/mod.rs'), 'utf8')
        .includes('fn connect_error'));
  }
}
