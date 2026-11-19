use serde::Serialize;
use std::fs;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};
use toml_edit::DocumentMut;

mod rollout;
mod sqlite;

const DEFAULT_PROVIDER_ID: &str = "openai";
const CONFIG_FILE_NAME: &str = "config.toml";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexSessionVisibilityRepairSummary {
    pub target_provider: String,
    pub changed_rollout_file_count: usize,
    pub updated_sqlite_row_count: usize,
    pub added_session_index_entry_count: usize,
    pub backup_dir: Option<String>,
    pub message: String,
}

/// 修复 Codex 历史会话可见性。
///
/// Codex Desktop 侧边栏按 `threads.model_provider == config.model_provider` 过滤。
/// 仅改 sqlite 不够：重启后 Codex 会从 rollout 的 `session_meta.model_provider`
/// 重新索引，把 sqlite 写回旧 provider（常见为 `openai`），历史再次消失。
///
/// 因此本修复会：
///   - 改 rollout / archived_sessions 中的 model_provider 元数据
///   - 改 official state db（sqlite）的 threads.model_provider 与可见性字段
///   - 备份 sqlite；失败时回滚 sqlite
pub fn repair_default_codex_session_visibility(
    codex_config_path: &Path,
) -> Result<CodexSessionVisibilityRepairSummary, String> {
    let data_dir = codex_config_path
        .parent()
        .ok_or_else(|| format!("无法定位 Codex 配置目录: {}", codex_config_path.display()))?;
    let target_provider = read_target_provider(data_dir)?;
    let sqlite_rows_to_update = sqlite::count_sqlite_rows_to_update(data_dir, &target_provider)?;
    let rollout_files_to_update = rollout::count_rollout_files_to_update(data_dir, &target_provider)?;

    if sqlite_rows_to_update == 0 && rollout_files_to_update == 0 {
        return Ok(CodexSessionVisibilityRepairSummary {
            target_provider,
            changed_rollout_file_count: 0,
            updated_sqlite_row_count: 0,
            added_session_index_entry_count: 0,
            backup_dir: None,
            message: "历史会话可见性已正常".to_string(),
        });
    }

    let backup_dir = sqlite::backup_sqlite_only(data_dir, &target_provider)?;
    sqlite::prune_old_backups(data_dir);

    let changed_rollout_file_count = match rollout::update_rollout_providers(data_dir, &target_provider) {
        Ok(n) => n,
        Err(error) => {
            let restore_result = sqlite::restore_sqlite_from_backup(data_dir, &backup_dir);
            if let Err(restore_error) = restore_result {
                return Err(format!(
                    "修复 Codex 历史会话可见性失败（rollout）: {}；自动回滚也失败: {}；备份目录: {}",
                    error,
                    restore_error,
                    backup_dir.display()
                ));
            }
            return Err(format!(
                "修复 Codex 历史会话可见性失败（rollout）: {}；已自动回滚 sqlite，备份目录: {}",
                error,
                backup_dir.display()
            ));
        }
    };

    let updated_sqlite_row_count = match sqlite::update_sqlite_provider(data_dir, &target_provider) {
        Ok(n) => n,
        Err(error) => {
            let restore_result = sqlite::restore_sqlite_from_backup(data_dir, &backup_dir);
            if let Err(restore_error) = restore_result {
                return Err(format!(
                    "修复 Codex 历史会话可见性失败（sqlite）: {}；自动回滚也失败: {}；备份目录: {}",
                    error,
                    restore_error,
                    backup_dir.display()
                ));
            }
            return Err(format!(
                "修复 Codex 历史会话可见性失败（sqlite）: {}；已自动回滚，备份目录: {}",
                error,
                backup_dir.display()
            ));
        }
    };

    let message = format!(
        "已恢复历史会话可见性（sqlite {} 条，rollout {} 个文件）",
        updated_sqlite_row_count, changed_rollout_file_count
    );

    // 修复成功后删除 sqlite 备份目录：备份只服务于「失败回滚」，成功即失去
    // 作用。state db 随会话增长可达数十 MB，不清理会在 ~/.codex 下长期残留
    // 冗余大文件（失败路径保留备份供排查，不受影响）。
    if let Err(cleanup_error) = fs::remove_dir_all(&backup_dir) {
        eprintln!(
            "[SessionVisibility] 清理备份目录失败（不影响修复结果）: {} ({})",
            backup_dir.display(), cleanup_error
        );
    }

    Ok(CodexSessionVisibilityRepairSummary {
        target_provider,
        changed_rollout_file_count,
        updated_sqlite_row_count,
        added_session_index_entry_count: 0,
        backup_dir: Some(backup_dir.to_string_lossy().to_string()),
        message,
    })
}

fn read_target_provider(data_dir: &Path) -> Result<String, String> {
    let config_path = data_dir.join(CONFIG_FILE_NAME);
    if !config_path.exists() {
        return Ok(DEFAULT_PROVIDER_ID.to_string());
    }
    let raw = fs::read_to_string(&config_path).map_err(|error| {
        format!(
            "读取 config.toml 失败 ({}): {}",
            config_path.display(),
            error
        )
    })?;
    if raw.trim().is_empty() {
        return Ok(DEFAULT_PROVIDER_ID.to_string());
    }
    let doc = raw.parse::<DocumentMut>().map_err(|error| {
        format!(
            "解析 config.toml 失败 ({}): {}",
            config_path.display(),
            error
        )
    })?;
    Ok(doc
        .get("model_provider")
        .and_then(|item| item.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(DEFAULT_PROVIDER_ID)
        .to_string())
}

pub(super) fn now_epoch_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests;
