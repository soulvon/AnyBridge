// config-dir.js — AnyBridge 配置目录的唯一定义处
//
// 之前每个模块各抄一份 appConfigDir / configDir（共 10 份），改一处漏九处就会让
// sidecar 与 Rust 端读到不同目录，表现为「改了配置不生效」这类极难排查的问题。
// 这里收敛为单一实现，语义必须与 Rust commands::config::config_dir() 严格一致：
//   Windows: %APPDATA%\<name>        (dirs::config_dir)
//   macOS:   ~/Library/Application Support/<name>  (dirs::data_dir)
//   Linux:   $XDG_CONFIG_HOME/<name> 或 ~/.config/<name>
// 目录名为 anybridge；旧版 ide-byok 仅在 anybridge 不存在时回退
// （真正的迁移由 Rust 侧 migrate_legacy_config_dir 完成）。

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const APP_CONFIG_DIR_NAME = 'anybridge';
export const LEGACY_CONFIG_DIR_NAME = 'ide-byok';

export function appConfigDir(name) {
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', name);
  if (process.platform === 'linux') return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), name);
  return process.env.APPDATA ? path.join(process.env.APPDATA, name) : path.join(os.homedir(), 'AppData', 'Roaming', name);
}

export function configDir() {
  if (process.env.BYOK_CONFIG_DIR) return process.env.BYOK_CONFIG_DIR;
  const next = appConfigDir(APP_CONFIG_DIR_NAME);
  if (fs.existsSync(next)) return next;
  const legacy = appConfigDir(LEGACY_CONFIG_DIR_NAME);
  return fs.existsSync(legacy) ? legacy : next;
}
