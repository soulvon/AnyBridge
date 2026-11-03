//! 启动自愈：清理历史遗留死文件，修复损坏的核心配置。
//!
//! 为什么需要：旧版本会在安装目录留下大量备份二进制（实测一台机器攒了 271MB：
//! `*.exe.bak-*`、`*.old.exe`、`*.prev.exe`、旧品牌的 `ide-byok*.exe`），用户
//! 不会自己去删；配置文件一旦被手工改坏，旧实现只是加载失败，界面上表现为
//! 「配置全没了」，用户也没有恢复手段。
//!
//! 这里做三件事，全部打日志、全部可从备份恢复：
//! 1. 删除安装目录里明确属于构建遗留的二进制（当前产物与卸载器永不删）；
//! 2. 删除已无写入方的死日志，并对超大日志兜底截断；
//! 3. 核心配置解析失败时，先备份损坏文件，再从最近的可用备份恢复；没有可用
//!    备份就保持原样不动——宁可让错误暴露，也不生成可能与当前版本不兼容的骨架。
//!
//! 清理只在启动时跑一次，且绝不删除用户配置与当前二进制。

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

/// 当前产品文件：即使名字命中下面的遗留规则也永不删除。
const CURRENT_BINARIES: [&str; 4] = [
    "anybridge.exe",
    "anybridge-proxy.exe",
    "anybridge-cursor-core.exe",
    "uninstall.exe",
];

/// 已无写入方的历史日志（保留名单外的一律不动，避免误伤排障日志）。
const DEAD_LOGS: [&str; 1] = ["ag-requests.log"];

/// 单个日志文件的兜底上限：主日志由写入方自己轮转，这里只兜住没人管的文件。
const LOG_HARD_LIMIT_BYTES: u64 = 64 * 1024 * 1024;

/// 每个配置文件保留的备份份数（更早的删掉，避免备份本身堆积成垃圾）。
const BACKUP_KEEP: usize = 3;

/// 核心配置：损坏时尝试从备份恢复。
const CORE_CONFIGS: [&str; 3] = ["providers.json", "proxy-routes.json", "model-map.json"];

#[derive(Debug, Default)]
pub struct HousekeepingReport {
    pub removed_binaries: Vec<String>,
    pub removed_logs: Vec<String>,
    pub truncated_logs: Vec<String>,
    pub healed_configs: Vec<String>,
    pub pruned_backups: Vec<String>,
    pub freed_bytes: u64,
}

impl HousekeepingReport {
    pub fn is_empty(&self) -> bool {
        self.removed_binaries.is_empty()
            && self.removed_logs.is_empty()
            && self.truncated_logs.is_empty()
            && self.healed_configs.is_empty()
            && self.pruned_backups.is_empty()
    }

    pub fn summary(&self) -> String {
        format!(
            "清理历史二进制 {} 个 / 死日志 {} 个 / 截断 {} 个 / 恢复配置 {} 个 / 清理备份 {} 个，释放 {:.1} MB",
            self.removed_binaries.len(),
            self.removed_logs.len(),
            self.truncated_logs.len(),
            self.healed_configs.len(),
            self.pruned_backups.len(),
            self.freed_bytes as f64 / (1024.0 * 1024.0)
        )
    }
}

/// 启动时在后台跑一轮自愈，不阻塞窗口显示。
pub fn run_startup_housekeeping() {
    let install_dir = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(Path::to_path_buf));
    let config_dir = crate::commands::config::config_dir_path();
    std::thread::spawn(move || {
        let Some(install_dir) = install_dir else { return };
        let report = housekeeping_once(&install_dir, &config_dir);
        if !report.is_empty() {
            eprintln!("[housekeeping] {}", report.summary());
        }
    });
}

pub fn housekeeping_once(install_dir: &Path, config_dir: &Path) -> HousekeepingReport {
    let mut report = HousekeepingReport::default();
    clean_install_binaries(install_dir, &mut report);
    clean_stale_logs(config_dir, &mut report);
    heal_core_configs(config_dir, &mut report);
    report
}

/// 构建遗留二进制：名字里带 .bak / .old / .prev，或属于改名前的旧品牌。
///
/// 旧品牌的 sidecar 是 `resolve_sidecar_path` 的兼容兜底——只有当同目录已经存在
/// 当前名字的 sidecar 时，它才算冗余；否则删掉会让老安装直接起不来。
fn is_stale_binary(name: &str, has_current_proxy: bool) -> bool {
    let lower = name.to_lowercase();
    if !lower.contains(".exe") {
        return false;
    }
    if CURRENT_BINARIES.contains(&lower.as_str()) {
        return false;
    }
    if lower.starts_with("ide-byok-proxy") {
        return has_current_proxy;
    }
    if lower.starts_with("ide-byok") {
        return true;
    }
    lower.contains(".bak") || lower.contains(".old") || lower.contains(".prev")
}

fn clean_install_binaries(install_dir: &Path, report: &mut HousekeepingReport) {
    let Ok(entries) = fs::read_dir(install_dir) else { return };
    let files: Vec<(PathBuf, String, u64)> = entries
        .flatten()
        .filter(|entry| entry.path().is_file())
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().to_string();
            let size = entry.metadata().map(|meta| meta.len()).unwrap_or(0);
            Some((entry.path(), name, size))
        })
        .collect();
    let has_current_proxy = files
        .iter()
        .any(|(_, name, _)| name.to_lowercase().starts_with("anybridge-proxy"));
    for (path, name, size) in files {
        if !is_stale_binary(&name, has_current_proxy) {
            continue;
        }
        if fs::remove_file(&path).is_ok() {
            report.freed_bytes += size;
            report.removed_binaries.push(name);
        }
        // 删除失败（进程占用等）不报错也不重试：下次启动会再试一次
    }
}

fn clean_stale_logs(config_dir: &Path, report: &mut HousekeepingReport) {
    for name in DEAD_LOGS {
        let path = config_dir.join(name);
        let Ok(meta) = fs::metadata(&path) else { continue };
        if fs::remove_file(&path).is_ok() {
            report.freed_bytes += meta.len();
            report.removed_logs.push(name.to_string());
        }
    }
    let Ok(entries) = fs::read_dir(config_dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else { continue };
        if !name.to_lowercase().ends_with(".log") {
            continue;
        }
        let Ok(meta) = entry.metadata() else { continue };
        if meta.len() <= LOG_HARD_LIMIT_BYTES {
            continue;
        }
        if fs::OpenOptions::new()
            .write(true)
            .open(&path)
            .and_then(|file| file.set_len(0))
            .is_ok()
        {
            report.freed_bytes += meta.len();
            report.truncated_logs.push(name.to_string());
        }
    }
}

/// 备份文件按时间倒序（新的在前）。识别 `<name>.bak-*` 与 `<name>.backup-*`。
fn config_backups(config_dir: &Path, name: &str) -> Vec<PathBuf> {
    let Ok(entries) = fs::read_dir(config_dir) else { return Vec::new() };
    let prefixes = [format!("{name}.bak-"), format!("{name}.backup-")];
    let mut found: Vec<(SystemTime, PathBuf)> = entries
        .flatten()
        .filter(|entry| entry.path().is_file())
        .filter_map(|entry| {
            let file_name = entry.file_name().to_string_lossy().to_string();
            if !prefixes.iter().any(|prefix| file_name.starts_with(prefix.as_str())) {
                return None;
            }
            let modified = entry
                .metadata()
                .and_then(|meta| meta.modified())
                .unwrap_or(UNIX_EPOCH);
            Some((modified, entry.path()))
        })
        .collect();
    found.sort_by(|a, b| b.0.cmp(&a.0));
    found.into_iter().map(|(_, path)| path).collect()
}

fn heal_core_configs(config_dir: &Path, report: &mut HousekeepingReport) {
    for name in CORE_CONFIGS {
        let path = config_dir.join(name);
        // 不存在 = 首次运行，不生成文件（各写入方有自己的默认值）
        let Ok(raw) = fs::read_to_string(&path) else { continue };
        if serde_json::from_str::<serde_json::Value>(&raw).is_ok() {
            // 正常文件：只裁剪过老的备份，保留最近几份用于回滚
            prune_backups(config_dir, name, report);
            continue;
        }

        // 损坏：先留证据，再从最近可用备份恢复
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let corrupt = config_dir.join(format!("{name}.corrupt-{stamp}"));
        if fs::copy(&path, &corrupt).is_err() {
            // 备份失败就绝不覆盖原文件
            continue;
        }
        let backups = config_backups(config_dir, name);
        let restored = backups
            .iter()
            .find(|backup| {
                fs::read_to_string(backup)
                    .ok()
                    .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
                    .is_some()
            })
            .cloned();
        match restored {
            Some(backup) => {
                if fs::copy(&backup, &path).is_ok() {
                    report.healed_configs.push(name.to_string());
                }
            }
            None => {
                // 没有可用备份：保持损坏原样，让上层继续报错（错误必须暴露）
                eprintln!("[housekeeping] {name} 已损坏且没有可用备份，已保留原文件并另存 {corrupt:?}");
            }
        }
        prune_backups(config_dir, name, report);
    }
}

fn prune_backups(config_dir: &Path, name: &str, report: &mut HousekeepingReport) {
    for backup in config_backups(config_dir, name).into_iter().skip(BACKUP_KEEP) {
        let size = fs::metadata(&backup).map(|meta| meta.len()).unwrap_or(0);
        if fs::remove_file(&backup).is_ok() {
            report.freed_bytes += size;
            report
                .pruned_backups
                .push(backup.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "anybridge-housekeeping-{tag}-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    #[test]
    fn removes_stale_binaries_but_keeps_current_ones() {
        let install = temp_dir("install");
        for name in [
            "anybridge.exe",
            "anybridge-proxy.exe",
            "anybridge-cursor-core.exe",
            "uninstall.exe",
            "anybridge-proxy.exe.bak-20261003",
            "anybridge-proxy.exe.bak-pre-fix",
            "anybridge-cursor-core.old.exe",
            "anybridge-cursor-core.prev.exe",
            "ide-byok-proxy.exe",
            "ide-byok.exe",
            "anything.dll",
        ] {
            fs::write(install.join(name), b"x").expect("seed");
        }

        let report = housekeeping_once(&install, &temp_dir("install-config"));

        for keep in [
            "anybridge.exe",
            "anybridge-proxy.exe",
            "anybridge-cursor-core.exe",
            "uninstall.exe",
            "anything.dll",
        ] {
            assert!(install.join(keep).exists(), "必须保留 {keep}");
        }
        for gone in [
            "anybridge-proxy.exe.bak-20261003",
            "anybridge-proxy.exe.bak-pre-fix",
            "anybridge-cursor-core.old.exe",
            "anybridge-cursor-core.prev.exe",
            "ide-byok-proxy.exe",
            "ide-byok.exe",
        ] {
            assert!(!install.join(gone).exists(), "必须清理 {gone}");
        }
        assert_eq!(report.removed_binaries.len(), 6);
        let _ = fs::remove_dir_all(&install);
    }

    #[test]
    fn keeps_legacy_sidecar_when_no_current_binary_exists() {
        let install = temp_dir("legacy-only");
        fs::write(install.join("ide-byok-proxy.exe"), b"x").expect("seed");

        let report = housekeeping_once(&install, &temp_dir("legacy-only-config"));

        // 老安装只剩旧名 sidecar 时，它是唯一可用副本，删了服务直接起不来
        assert!(install.join("ide-byok-proxy.exe").exists());
        assert!(report.removed_binaries.is_empty());
        let _ = fs::remove_dir_all(&install);
    }

    #[test]
    fn removes_dead_log_and_truncates_oversized_log() {
        let config = temp_dir("logs");
        fs::write(config.join("ag-requests.log"), vec![b'x'; 1024]).expect("seed dead log");
        fs::create_dir_all(&config).ok();

        let big = config.join("ag-handshake.log");
        fs::write(&big, vec![b'y'; (LOG_HARD_LIMIT_BYTES + 1) as usize]).expect("seed big log");

        let report = housekeeping_once(&temp_dir("logs-install"), &config);

        assert!(!config.join("ag-requests.log").exists());
        assert_eq!(fs::metadata(&big).map(|m| m.len()).unwrap_or(1), 0);
        assert!(report.removed_logs.contains(&"ag-requests.log".to_string()));
        assert!(report.truncated_logs.contains(&"ag-handshake.log".to_string()));
        let _ = fs::remove_dir_all(&config);
    }

    #[test]
    fn restores_corrupt_config_from_latest_usable_backup() {
        let config = temp_dir("heal");
        // 两个备份：新的这份本身是坏的，旧的那份可用 → 必须跳过坏的继续找
        fs::write(config.join("providers.json"), b"{ broken json").expect("seed corrupt");
        fs::write(config.join("providers.json.bak-1"), b"{ also broken").expect("seed bad backup");
        fs::write(config.join("providers.json.bak-2"), br#"{"providers":[{"id":"p1"}]}"#)
            .expect("seed good backup");

        let report = housekeeping_once(&temp_dir("heal-install"), &config);

        let healed = fs::read_to_string(config.join("providers.json")).expect("read healed");
        let parsed: serde_json::Value = serde_json::from_str(&healed).expect("valid json");
        assert_eq!(parsed["providers"][0]["id"], "p1");
        assert!(report.healed_configs.contains(&"providers.json".to_string()));

        // 损坏现场必须留证据
        let corrupt_count = fs::read_dir(&config)
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().starts_with("providers.json.corrupt-"))
            .count();
        assert_eq!(corrupt_count, 1);
        let _ = fs::remove_dir_all(&config);
    }

    #[test]
    fn keeps_corrupt_file_untouched_when_no_usable_backup() {
        let config = temp_dir("no-backup");
        fs::write(config.join("model-map.json"), b"{ broken").expect("seed");

        let report = housekeeping_once(&temp_dir("no-backup-install"), &config);

        // 没有可用备份时保持原样：错误必须暴露，不能静默重置成空配置
        assert_eq!(fs::read_to_string(config.join("model-map.json")).unwrap(), "{ broken");
        assert!(report.healed_configs.is_empty());
        let _ = fs::remove_dir_all(&config);
    }

    #[test]
    fn prunes_old_backups_beyond_keep_limit() {
        let config = temp_dir("prune");
        fs::write(config.join("providers.json"), br#"{"providers":[]}"#).expect("seed main");
        for index in 0..6 {
            fs::write(
                config.join(format!("providers.json.bak-{index}")),
                br#"{"providers":[]}"#,
            )
            .expect("seed backup");
            // 拉开 mtime，保证"最近 N 份"判定稳定
            std::thread::sleep(std::time::Duration::from_millis(15));
        }

        let report = housekeeping_once(&temp_dir("prune-install"), &config);

        let remaining = fs::read_dir(&config)
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().starts_with("providers.json.bak-"))
            .count();
        assert_eq!(remaining, BACKUP_KEEP);
        assert_eq!(report.pruned_backups.len(), 3);
        let _ = fs::remove_dir_all(&config);
    }
}
