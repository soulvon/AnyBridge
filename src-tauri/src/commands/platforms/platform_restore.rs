use super::buddy::restore_buddy_fields_via_stash;
use super::claude::restore_claude_fields_via_stash;
use super::common::{
    agent_stash_dir, remove_backup_if_exists, remove_file_if_exists, restore_one_file,
    PLATFORM_CLAUDE_DESKTOP,
};
use super::deepseek_harness::{harness_credentials_stash_key, harness_stash_key};
use super::hermes::hermes_stash_key;
use super::opencode::restore_opencode_fields_via_stash;
use super::pi::pi_stash_key;
use super::platform_enum::Platform;
use super::yaml_block::restore_yaml_fields_via_stash;
use super::zcode::zcode_stash_key;
use super::zcode_sync::zcode_personal_config_path;

fn try_field_restore(label: &str, res: Result<bool, String>) -> bool {
    match res {
        Ok(restored) => restored,
        Err(e) => {
            eprintln!("[agent-stash] {label} 字段级还原失败，退回整文件还原: {e}");
            false
        }
    }
}

fn restore_yaml_and_cleanup_at(
    label: &str,
    path: &std::path::PathBuf,
    key: &crate::commands::agent_stash::StashKey,
    stash_dir: &std::path::Path,
    companion: Option<&std::path::Path>,
) -> Result<bool, String> {
    if !try_field_restore(
        label,
        restore_yaml_fields_via_stash(path, key, stash_dir, label),
    ) {
        return Ok(false);
    }
    remove_backup_if_exists(path)?;
    if let Some(comp) = companion {
        remove_file_if_exists(comp)?;
    }
    Ok(true)
}

impl Platform {

    /// 从 `.byok-bak` 或字段级账本还原；字段还原成功后同步清理残留 `.byok-bak` 及伴生状态文件。
    pub(in crate::commands::platforms) fn restore(&self) -> Result<bool, String> {
        if matches!(self, Platform::ClaudeDesktop) {
            let res = crate::commands::claude_desktop::restore_claude_desktop_sync()?;
            crate::commands::store_io::update_provider_store(|store| {
                let changed = store.platforms.remove(PLATFORM_CLAUDE_DESKTOP).is_some();
                Ok((changed, ()))
            })?;
            return Ok(res.ok);
        }

        let path = self
            .config_path()
            .ok_or_else(|| "无法定位用户主目录".to_string())?;

        if matches!(self, Platform::Antigravity) {
            let _guard = crate::commands::inject_lock();
            let restored = restore_one_file(&path)?;
            if !restored {
                let _ = self.apply_antigravity_official_with_stash_locked(&path, &agent_stash_dir(), !cfg!(test));
            }
            // 要么已从备份还原，要么已回写官方配置，都视为还原成功
            return Ok(true);
        }

        if matches!(self, Platform::AntigravityIde) {
            let _guard = crate::commands::inject_lock();
            let restored = restore_one_file(&path)?;
            if !restored {
                let _ = self.apply_antigravity_ide_official_with_stash_locked(&path, &agent_stash_dir(), !cfg!(test));
            }
            return Ok(true);
        }

        let field_restore = crate::commands::agent_stash::field_restore_enabled();

        // Claude Code：门控开启时优先字段级还原（写回原值，保留接管期间
        // 用户对其它字段的改动）；无记账记录或还原失败 → 退回整文件还原。
        if matches!(self, Platform::ClaudeCode)
            && field_restore
            && try_field_restore(
                "Claude Code",
                restore_claude_fields_via_stash(&path, &agent_stash_dir()),
            )
        {
            remove_backup_if_exists(&path)?;
            return Ok(true);
        }

        // OpenCode：同 Claude Code 的门控策略（opencode.json 字段级；
        // auth.json 保持整文件备份还原，不在记账范围）。
        if matches!(self, Platform::OpenCode)
            && field_restore
            && try_field_restore(
                "OpenCode",
                restore_opencode_fields_via_stash(&path, &agent_stash_dir()),
            )
        {
            remove_backup_if_exists(&path)?;
            if let Some(auth_path) = self.opencode_auth_path() {
                restore_one_file(&auth_path)?;
            }
            return Ok(true);
        }

        // ZCode：主配置与 cli 配置各自字段级还原；personal 配置无记账，
        // 保持整文件还原；无任何账本记录 → 退回整文件还原。
        if matches!(self, Platform::ZCode) && field_restore {
            let stash_dir = agent_stash_dir();
            let main_ok = try_field_restore(
                "ZCode",
                crate::commands::field_restore::restore_json_fields_via_stash(
                    &path,
                    &zcode_stash_key("config.json"),
                    &stash_dir,
                    "ZCode",
                ),
            );
            let cli_path = self.zcode_cli_config_path();
            let cli_ok = cli_path.as_ref().is_some_and(|p| {
                try_field_restore(
                    "ZCode cli",
                    crate::commands::field_restore::restore_json_fields_via_stash(
                        p,
                        &zcode_stash_key("cli/config.json"),
                        &stash_dir,
                        "ZCode cli",
                    ),
                )
            });
            if main_ok {
                remove_backup_if_exists(&path)?;
            }
            if cli_ok {
                if let Some(p) = cli_path.as_ref() {
                    remove_backup_if_exists(p)?;
                }
            }
            if let Ok(personal_path) = zcode_personal_config_path() {
                restore_one_file(&personal_path)?;
            }
            if main_ok || cli_ok {
                return Ok(true);
            }
            // 无账本记录 → 落到下方整文件还原
        }

        // Buddy（CodeBuddy / WorkBuddy）：models.json 数组按 id 字段级还原。
        if matches!(self, Platform::CodeBuddy | Platform::WorkBuddy) && field_restore {
            let platform_key = if matches!(self, Platform::WorkBuddy) {
                "workbuddy"
            } else {
                "codebuddy"
            };
            if try_field_restore(
                "Buddy",
                restore_buddy_fields_via_stash(&path, platform_key, &agent_stash_dir()),
            ) {
                remove_backup_if_exists(&path)?;
                return Ok(true);
            }
        }

        // Pi：models.json 的 providers.<id>（对象键）+ settings.json 的默认指针
        // 各自字段级还原；停用状态文件由 AnyBridge 维护，还原时清理。
        if matches!(self, Platform::Pi) && field_restore {
            let stash_dir = agent_stash_dir();
            let models_ok = try_field_restore(
                "Pi models",
                crate::commands::field_restore::restore_json_fields_via_stash(
                    &path,
                    &pi_stash_key("models.json"),
                    &stash_dir,
                    "Pi models",
                ),
            );
            let settings_path = self.pi_settings_path();
            let settings_ok = settings_path.as_ref().is_some_and(|sp| {
                try_field_restore(
                    "Pi settings",
                    crate::commands::field_restore::restore_json_fields_via_stash(
                        sp,
                        &pi_stash_key("settings.json"),
                        &stash_dir,
                        "Pi settings",
                    ),
                )
            });
            if models_ok {
                remove_backup_if_exists(&path)?;
            }
            if settings_ok {
                if let Some(sp) = settings_path.as_ref() {
                    remove_backup_if_exists(sp)?;
                }
            }
            if models_ok || settings_ok {
                if let Some(disabled_path) = self.pi_disabled_models_path() {
                    remove_file_if_exists(&disabled_path)?;
                }
                return Ok(true);
            }
            // 无账本记录 → 落到下方整文件还原
        }

        if matches!(self, Platform::OpenCode) {
            let mut restored = restore_one_file(&path)?;
            if let Some(auth_path) = self.opencode_auth_path() {
                restored = restore_one_file(&auth_path)? || restored;
            }
            return Ok(restored);
        }

        if matches!(self, Platform::ZCode) {
            let mut restored = restore_one_file(&path)?;
            if let Some(cli_path) = self.zcode_cli_config_path() {
                restored = restore_one_file(&cli_path)? || restored;
            }
            if let Ok(personal_path) = zcode_personal_config_path() {
                restored = restore_one_file(&personal_path)? || restored;
            }
            return Ok(restored);
        }

        if matches!(self, Platform::Pi) {
            let mut restored = restore_one_file(&path)?;
            if let Some(settings_path) = self.pi_settings_path() {
                restored = restore_one_file(&settings_path)? || restored;
            }
            // 停用状态文件由 AnyBridge 维护，还原时一并清除
            if let Some(disabled_path) = self.pi_disabled_models_path() {
                remove_file_if_exists(&disabled_path)?;
            }
            return Ok(restored);
        }

        // Hermes / DeepSeek Harness：块级 YAML 账本还原（custom_providers /
        // llm-pi-ai / agent-default-model / refs）。用户接管期间动过的块整块
        // 跳过，绝不覆盖；无账本记录 → 退回整文件还原。
        if matches!(self, Platform::Hermes)
            && field_restore
            && restore_yaml_and_cleanup_at(
                "Hermes",
                &path,
                &hermes_stash_key(),
                &agent_stash_dir(),
                self.managed_disabled_models_path().as_deref(),
            )?
        {
            return Ok(true);
        }

        if matches!(self, Platform::DeepSeekHarness) && field_restore {
            let stash_dir = agent_stash_dir();
            let settings_ok = try_field_restore(
                "Harness settings",
                restore_yaml_fields_via_stash(
                    &path,
                    &harness_stash_key(),
                    &stash_dir,
                    "Harness settings",
                ),
            );
            let credentials = self.deepseek_harness_credentials_path();
            let cred_ok = credentials.as_ref().is_some_and(|cred_path| {
                try_field_restore(
                    "Harness credentials",
                    restore_yaml_fields_via_stash(
                        cred_path,
                        &harness_credentials_stash_key(),
                        &stash_dir,
                        "Harness credentials",
                    ),
                )
            });
            if settings_ok {
                remove_backup_if_exists(&path)?;
            }
            if cred_ok {
                if let Some(cred_path) = credentials.as_ref() {
                    remove_backup_if_exists(cred_path)?;
                }
            }
            if settings_ok || cred_ok {
                if let Some(disabled_path) = self.managed_disabled_models_path() {
                    remove_file_if_exists(&disabled_path)?;
                }
                return Ok(true);
            }
        }

        if matches!(self, Platform::Hermes) {
            let restored = restore_one_file(&path)?;
            if let Some(disabled_path) = self.managed_disabled_models_path() {
                remove_file_if_exists(&disabled_path)?;
            }
            return Ok(restored);
        }

        if matches!(self, Platform::DeepSeekHarness) {
            let mut restored = restore_one_file(&path)?;
            if let Some(credentials) = self.deepseek_harness_credentials_path() {
                restored = restore_one_file(&credentials)? || restored;
            }
            if let Some(disabled_path) = self.managed_disabled_models_path() {
                remove_file_if_exists(&disabled_path)?;
            }
            return Ok(restored);
        }

        restore_one_file(&path)
    }

}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::agent_stash::{record_apply, FieldPlan, Stashed};
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn field_restore_cleanup_removes_byok_bak_and_companion_state_file() {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "anybridge-plat-restore-{}-{nanos}",
            std::process::id()
        ));
        fs::create_dir_all(&dir).unwrap();

        let cfg = dir.join("config.yaml");
        let bak = super::super::common::backup_path(&cfg);
        let companion = dir.join(super::super::common::MANAGED_MODELS_STATE_FILE);
        let stash = dir.join("stash");

        fs::write(&cfg, "model:\n  default: managed-model\nuser_keep: true\n").unwrap();
        fs::write(&bak, "model:\n  default: user-orig\n").unwrap();
        fs::write(&companion, r#"{"disabled":["x"]}"#).unwrap();

        let key = hermes_stash_key();
        record_apply(
            &stash,
            &key,
            &[FieldPlan {
                path: vec!["model".into(), "default".into()],
                current: Stashed::Str("user-orig".into()),
                new: Stashed::Str("managed-model".into()),
            }],
        )
        .unwrap();

        let restored = restore_yaml_and_cleanup_at(
            "Hermes",
            &cfg,
            &key,
            &stash,
            Some(&companion),
        )
        .unwrap();
        assert!(restored);
        assert!(!bak.exists(), "字段还原成功后必须删除残留 .byok-bak");
        assert!(
            !companion.exists(),
            "字段还原成功后必须清除伴生状态文件 anybridge-models-state.json"
        );
        let content = fs::read_to_string(&cfg).unwrap();
        assert!(content.contains("user-orig"));
        assert!(content.contains("user_keep: true"));
        let _ = fs::remove_dir_all(&dir);
    }
}
