#!/usr/bin/env node
/**
 * Antigravity Kite 共存门控 —— 防止两个项目互相踩。
 *
 *   node scripts/check-kite-coexist.mjs
 *
 * 背景：Kite（多账号切号扩展）与 AnyBridge 作用于同一个 IDE 实例。
 * 已发生的冲突：双方都硬编码 CDP 9333；Kite 改快捷方式+后台重启 IDE；
 * 双方都杀 agy.exe；双方并发写同一个 User/settings.json；
 * AnyBridge 整体重写 JSON 会丢掉 Kite 刚写的 antigravityKite.* 键。
 *
 * 契约（AnyBridge 侧，单向可验证）：
 *   1. CDP 端口动态发现：跟随 Kite 配置 cdpPort / DevToolsActivePort / 9222 兜底，
 *      不再写死 9333；探测失败不弹错。
 *   2. 调试端口已就绪时直接补注入，绝不重启 IDE 主进程（重启权归 Kite/用户）。
 *   3. settings.json 只做「一行最小替换」，Kite 的键/注释/格式逐字节保留；
 *      写入前重读最新内容；无变更不写。
 *   4. 不碰 Kite 独占资源：state.vscdb（Antigravity 端）、Windows 凭据、
 *      ~/.gemini、.lnk 快捷方式、antigravityKite.* 配置键、11451~11550 OAuth 端口。
 *   5. CDP 注入全局标记与 Kite 的 __kiteDeclGuard* 不重名，target 过滤互不相交。
 *
 * 退出码：0 = 全部通过；1 = 有失败（必须修复后重跑）。
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

const cdp = fs.readFileSync(path.join(root, 'src-tauri/src/commands/antigravity_cdp.rs'), 'utf8');
const platforms = fs.readFileSync(path.join(root, 'src-tauri/src/commands/platforms.rs'), 'utf8');
const system = fs.readFileSync(path.join(root, 'src-tauri/src/commands/system.rs'), 'utf8');
const appLoc = fs.readFileSync(path.join(root, 'src-tauri/src/commands/app_localization.rs'), 'utf8');

section('CDP 端口：跟随 Kite 而非硬编码');
{
  ok('CDP_PORT 仅作兜底常量，probe 走动态发现',
    cdp.includes('pub fn resolve_cdp_port()') && cdp.includes('pub fn probe() -> Result<String, String>')
    && /pub fn probe\(\)[\s\S]{0,120}resolve_cdp_port\(\)/.test(cdp));
  ok('候选包含 Kite 配置端口 antigravityKite.cdpPort',
    cdp.includes('antigravityKite.cdpPort') && cdp.includes('kite_configured_cdp_port'));
  ok('候选包含 DevToolsActivePort 与 9222 兜底',
    cdp.includes('DevToolsActivePort') && cdp.includes('KITE_FALLBACK_CDP_PORT') && cdp.includes('9222'));
  ok('活跃端口被缓存，Kite 重启 IDE 后可重新收敛',
    cdp.includes('ACTIVE_CDP_PORT') && cdp.includes('store(0, Ordering::Relaxed)'));
  ok('cdp_base / status 使用动态端口',
    cdp.includes('fn cdp_base() -> String {\n    format!("http://127.0.0.1:{}", current_cdp_port())')
    || (cdp.includes('current_cdp_port())') && cdp.includes('st.port = current_cdp_port()')));
  ok('端口跟随契约有单测', platforms.includes('antigravity_cdp_port_follows_kite_config'));
}

section('重启权：不抢 Kite 的 IDE 主进程');
{
  const restart = system.slice(system.indexOf('pub async fn restart_antigravity_ide_with_cdp'));
  ok('调试端口就绪时直接注入、不调用 restart_ide_impl',
    restart.includes('probe()') && restart.includes('inject_once')
    && restart.indexOf('if cdp.is_ok()') < restart.indexOf('restart_ide_impl'));
  ok('复用已发现的真实端口（不强制 9333 重启）',
    restart.includes('active_port()') && restart.includes('未重启 IDE'));
  ok('不修改快捷方式 .lnk', !cdp.includes('.lnk') && !platforms.includes('WScript.Shell'));
}

section('settings.json：并发写不覆盖 Kite');
{
  ok('最小替换纯函数存在', platforms.includes('fn upsert_settings_endpoint_text'));
  ok('写入前重读最新内容', platforms.includes('fn write_settings_endpoint') && /fs::read_to_string\(path\)/.test(platforms));
  ok('无变更不写（幂等）', platforms.includes('if next == raw'));
  ok('接入与还原共 5 处都走最小替换',
    (platforms.match(/write_settings_endpoint\(/g) || []).length >= 6);
  ok('不再整体重写 Antigravity settings',
    (() => {
      const start = platforms.indexOf('fn apply_antigravity_ide_with_stash');
      const end = platforms.indexOf('fn apply_claude(', start);
      const seg = platforms.slice(start, end);
      return !seg.includes('to_string_pretty(&Value::Object(obj))');
    })());
  ok('Kite 键/注释逐字节保留有单测', platforms.includes('antigravity_settings_write_preserves_kite_keys_and_format'));
}

section('资源边界：不碰 Kite 独占资源');
{
  // 只检查 Antigravity 相关模块（其它产品的 state.vscdb 处理是合法的）。
  const agFiles = [cdp, platforms, appLoc];
  const joined = agFiles.join('\n');
  ok('不读写 Antigravity 的 state.vscdb', !joined.includes('antigravity') || !/antigravity[\s\S]{0,80}state\.vscdb/.test(joined));
  ok('不碰 Windows 凭据管理器 gemini:antigravity', !joined.includes('gemini:antigravity'));
  ok('不写 ~/.gemini 账号凭证文件',
    !joined.includes('oauth_creds.json') && !joined.includes('google_accounts.json'));
  // 只查业务代码段且排除注释行；说明兼容意图的注释与测试里的夹具不算越界。
  const business = platforms
    .slice(0, platforms.indexOf('#[cfg(test)]\nmod tests'))
    .split(/\r?\n/)
    .filter(l => !/^\s*(\/\/|\/\*|\*)/.test(l))
    .join('\n');
  const cdpCode = cdp.split(/\r?\n/).filter(l => !/^\s*(\/\/|\/\/\/|\/\*|\*)/.test(l)).join('\n');
  const cdpKiteReads = (cdpCode.match(/antigravityKite\./g) || []).length;
  ok('不读写 antigravityKite.* 配置键（仅允许只读 cdpPort 一次）',
    !business.includes('antigravityKite.') && cdpKiteReads === 1
    && cdpCode.includes('"antigravityKite.cdpPort"'));
  ok('不占用 Kite 的 OAuth 回调端口段 11451~11550', !joined.includes('11451'));
}

section('CDP 注入：全局标记与 target 互不干扰');
{
  ok('汉化注入标记是 AnyBridge 专属',
    (cdp.includes('__anybridgeCdpHans') || appLoc.includes('__anybridgeCdpHans'))
    && !(cdp.includes('__kiteDeclGuard') || appLoc.includes('__kiteDeclGuard')));
  ok('target 过滤只认本机 hub 页面',
    cdp.includes('is_app_target') && cdp.includes('/settings-standalone') && cdp.includes('extensionView=true'));
  ok('keeper 探测失败时静默跳过（不弹错）',
    cdp.includes('probe().is_ok()') && cdp.includes('补注入跳过'));
}

section('Rust 单测（共存契约）');
{
  try {
    const out = execFileSync('cargo', ['test', '--manifest-path', 'src-tauri/Cargo.toml', '--lib', 'antigravity_'], {
      cwd: root, encoding: 'utf8', stdio: 'pipe', timeout: 240000,
    });
    const m = /test result: ok\. (\d+) passed/.exec(out);
    ok(`Antigravity 单测全绿（${m ? m[1] : '?'} 项）`, !!m);
  } catch (e) {
    ok('Antigravity 单测全绿', false, String(e.stdout || e.message).slice(-400));
  }
}

console.log(`\n════════════════════════════════════`);
console.log(`通过 ${passed} ｜ 失败 ${failed}`);
console.log(failed === 0 ? '✅ Kite 共存门控通过' : '❌ 存在失败项——必须修复后重跑');
process.exit(failed === 0 ? 0 : 1);
