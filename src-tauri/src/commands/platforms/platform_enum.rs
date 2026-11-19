use crate::commands::config::Provider;
use std::fs;
use std::path::PathBuf;

use super::common::{
    app_data_dir, backup_path, ensure_backup, MANAGED_MODELS_STATE_FILE, PLATFORM_ANTIGRAVITY,
    PLATFORM_ANTIGRAVITY_IDE, PLATFORM_CLAUDE_CODE, PLATFORM_CLAUDE_DESKTOP, PLATFORM_CODEBUDDY,
    PLATFORM_CODEX, PLATFORM_DEEPSEEK_HARNESS, PLATFORM_GROK, PLATFORM_HERMES, PLATFORM_OPENCODE,
    PLATFORM_PI, PLATFORM_WORKBUDDY, PLATFORM_ZCODE,
};
use super::deepseek_harness::{harness_entries_from_provider, write_harness_managed_models};
use super::hermes::{hermes_entries_from_provider, write_hermes_managed_models};


// ─── 平台抽象 ──────────────────────────────────────────────────

pub(crate) enum Platform {
    Antigravity,
    AntigravityIde,
    ClaudeCode,
    ClaudeDesktop,
    Codex,
    CodeBuddy,
    Grok,
    OpenCode,
    WorkBuddy,
    ZCode,
    Pi,
    Hermes,
    DeepSeekHarness,
}

impl Platform {
    pub(crate) fn from_id(id: &str) -> Option<Self> {
        match id {
            PLATFORM_ANTIGRAVITY => Some(Platform::Antigravity),
            PLATFORM_ANTIGRAVITY_IDE => Some(Platform::AntigravityIde),
            PLATFORM_CLAUDE_CODE => Some(Platform::ClaudeCode),
            PLATFORM_CLAUDE_DESKTOP => Some(Platform::ClaudeDesktop),
            PLATFORM_CODEX => Some(Platform::Codex),
            PLATFORM_CODEBUDDY => Some(Platform::CodeBuddy),
            PLATFORM_GROK => Some(Platform::Grok),
            PLATFORM_OPENCODE => Some(Platform::OpenCode),
            PLATFORM_WORKBUDDY => Some(Platform::WorkBuddy),
            PLATFORM_ZCODE => Some(Platform::ZCode),
            PLATFORM_PI => Some(Platform::Pi),
            PLATFORM_HERMES => Some(Platform::Hermes),
            PLATFORM_DEEPSEEK_HARNESS => Some(Platform::DeepSeekHarness),
            _ => None,
        }
    }


    pub(crate) fn id(&self) -> &'static str {
        match self {
            Platform::Antigravity => PLATFORM_ANTIGRAVITY,
            Platform::AntigravityIde => PLATFORM_ANTIGRAVITY_IDE,
            Platform::ClaudeCode => PLATFORM_CLAUDE_CODE,
            Platform::ClaudeDesktop => PLATFORM_CLAUDE_DESKTOP,
            Platform::Codex => PLATFORM_CODEX,
            Platform::CodeBuddy => PLATFORM_CODEBUDDY,
            Platform::Grok => PLATFORM_GROK,
            Platform::OpenCode => PLATFORM_OPENCODE,
            Platform::WorkBuddy => PLATFORM_WORKBUDDY,
            Platform::ZCode => PLATFORM_ZCODE,
            Platform::Pi => PLATFORM_PI,
            Platform::Hermes => PLATFORM_HERMES,
            Platform::DeepSeekHarness => PLATFORM_DEEPSEEK_HARNESS,
        }
    }


    pub(crate) fn display_name(&self) -> &'static str {
        // 元数据单一真源：agent_spec::AGENTS（新增平台只需加一条声明）
        crate::commands::agent_spec::find(self.id()).map(|s| s.name).unwrap_or("Unknown")
    }


    pub(crate) fn vendor(&self) -> &'static str {
        crate::commands::agent_spec::find(self.id()).map(|s| s.vendor).unwrap_or("Unknown")
    }


    /// 该平台需要的中转站协议格式。
    pub(crate) fn required_api_format(&self) -> &'static str {
        crate::commands::agent_spec::find(self.id())
            .map(|s| s.api_format)
            .unwrap_or("openai")
    }


    /// 配置目录（用于检测是否安装）。
    pub(crate) fn config_dir(&self) -> Option<PathBuf> {
        // 路径解析统一走声明（模板展开 / 复用既有定位函数）
        crate::commands::agent_spec::find(self.id())?.resolve_config_dir()
    }


    /// 配置文件路径。
    pub(crate) fn config_path(&self) -> Option<PathBuf> {
        crate::commands::agent_spec::find(self.id())?.resolve_config_path()
    }


    pub(in crate::commands::platforms) fn opencode_auth_path(&self) -> Option<PathBuf> {
        if !matches!(self, Platform::OpenCode) {
            return None;
        }
        let home = dirs::home_dir()?;
        Some(
            home.join(".local")
                .join("share")
                .join("opencode")
                .join("auth.json"),
        )
    }


    pub(in crate::commands::platforms) fn zcode_cli_config_path(&self) -> Option<PathBuf> {
        if !matches!(self, Platform::ZCode) {
            return None;
        }
        let home = dirs::home_dir()?;
        Some(home.join(".zcode").join("cli").join("config.json"))
    }


    /// Pi 的 settings.json（默认模型等偏好，随 models.json 一起接管与还原）。
    pub(in crate::commands::platforms) fn pi_settings_path(&self) -> Option<PathBuf> {
        if !matches!(self, Platform::Pi) {
            return None;
        }
        Some(self.config_dir()?.join("settings.json"))
    }


    /// AnyBridge 维护的 Pi「已停用条目」状态文件（Pi 不读取它）。
    pub(in crate::commands::platforms) fn pi_disabled_models_path(&self) -> Option<PathBuf> {
        if !matches!(self, Platform::Pi) {
            return None;
        }
        Some(self.config_dir()?.join(MANAGED_MODELS_STATE_FILE))
    }


    /// DeepSeek Harness 凭据文件：provider 只存 `apiKeyEnv` 引用，密钥本体写在这里。
    pub(in crate::commands::platforms) fn deepseek_harness_credentials_path(&self) -> Option<PathBuf> {
        if !matches!(self, Platform::DeepSeekHarness) {
            return None;
        }
        Some(self.config_dir()?.join(".credentials.yaml"))
    }


    /// 受管模型表格的「已停用条目」状态文件（Hermes / DeepSeek Harness）。
    pub(in crate::commands::platforms) fn managed_disabled_models_path(&self) -> Option<PathBuf> {
        if !matches!(self, Platform::Hermes | Platform::DeepSeekHarness) {
            return None;
        }
        Some(self.config_dir()?.join(MANAGED_MODELS_STATE_FILE))
    }


    /// 检测工具是否安装：配置目录存在即视为已安装（文件可能尚未生成）。
    pub(in crate::commands::platforms) fn detect_installed(&self) -> bool {
        if matches!(self, Platform::ClaudeDesktop) {
            return crate::commands::claude_desktop::current_platform_paths()
                .map(|p| p.normal_dir.exists() || p.threep_dir.exists())
                .unwrap_or(false);
        }
        if self.config_dir().map(|d| d.exists()).unwrap_or(false) {
            return true;
        }
        // magpie 三选一的 Bin 分支：CLI 可执行文件命中 = 已安装。
        // 实测场景：Hermes 的 CLI 装在 %LOCALAPPDATA%\hermes\bin（uv tool），
        // 但 ~/.hermes 配置目录尚未生成——只看配置目录会误报「未安装」。
        // find_tool 自带 5 分钟缓存（含注册表 PATH 与 npm 前缀目录）。
        if let Some(bin) = self.cli_bin() {
            if crate::commands::version_probe::find_tool(bin).is_some() {
                return true;
            }
        }
        match self {
            Platform::Antigravity => {
                if let Some(local) = dirs::data_local_dir() {
                    if local
                        .join("Programs")
                        .join("antigravity")
                        .join("Antigravity.exe")
                        .exists()
                    {
                        return true;
                    }
                }
                if let Some(data) = dirs::data_dir() {
                    if data.join("Antigravity").exists() {
                        return true;
                    }
                }
                if let Some(home) = dirs::home_dir() {
                    if home.join(".gemini").join("antigravity").exists() {
                        return true;
                    }
                }
                false
            }
            Platform::AntigravityIde => {
                if let Some(local) = dirs::data_local_dir() {
                    if local
                        .join("Programs")
                        .join("Antigravity IDE")
                        .join("Antigravity IDE.exe")
                        .exists()
                    {
                        return true;
                    }
                }
                if let Some(data) = dirs::data_dir() {
                    if data.join("Antigravity IDE").exists() {
                        return true;
                    }
                }
                if let Some(home) = dirs::home_dir() {
                    if home.join(".gemini").join("antigravity-ide").exists() {
                        return true;
                    }
                }
                false
            }
            Platform::CodeBuddy => app_data_dir("CodeBuddy")
                .map(|d| d.exists())
                .unwrap_or(false),
            Platform::OpenCode => {
                self.opencode_auth_path()
                    .and_then(|p| p.parent().map(|d| d.exists()))
                    .unwrap_or(false)
                    || app_data_dir("OpenCode")
                        .map(|d| d.exists())
                        .unwrap_or(false)
            }
            Platform::WorkBuddy => app_data_dir("WorkBuddy")
                .map(|d| d.exists())
                .unwrap_or(false),
            Platform::ZCode => {
                app_data_dir("ZCode").map(|d| d.exists()).unwrap_or(false)
                    || app_data_dir("ai.z.zcode")
                        .map(|d| d.exists())
                        .unwrap_or(false)
            }
            // Pi 的配置目录可能尚未生成（只装了 CLI），~/.pi 存在同样视为已安装。
            Platform::Pi => dirs::home_dir()
                .map(|home| home.join(".pi").exists())
                .unwrap_or(false),
            // Hermes / DeepSeek Harness：配置目录存在即已安装（配置文件可能尚未生成）
            Platform::Hermes => self
                .config_dir()
                .map(|d| d.exists() || self.config_path().map(|p| p.exists()).unwrap_or(false))
                .unwrap_or(false),
            Platform::DeepSeekHarness => self.config_dir().map(|d| d.exists()).unwrap_or(false),
            _ => false,
        }
    }


    /// 该平台对应的 CLI 可执行名（检测/版本探测共用，借鉴 magpie 的 Bin 字段）。
    pub(in crate::commands::platforms) fn cli_bin(&self) -> Option<&'static str> {
        match self {
            Platform::ClaudeCode => Some("claude"),
            Platform::Codex => Some("codex"),
            Platform::Grok => Some("grok"),
            Platform::OpenCode => Some("opencode"),
            Platform::CodeBuddy => Some("codebuddy"),
            Platform::WorkBuddy => Some("workbuddy"),
            Platform::ZCode => Some("zcode"),
            Platform::Pi => Some("pi"),
            Platform::Hermes => Some("hermes"),
            Platform::DeepSeekHarness => Some("dsh"),
            Platform::Antigravity
            | Platform::AntigravityIde
            | Platform::ClaudeDesktop => None,
        }
    }


    pub(in crate::commands::platforms) fn backup_exists(&self) -> bool {
        if matches!(self, Platform::ClaudeDesktop) {
            return crate::commands::claude_desktop::current_platform_paths()
                .map(|p| p.profile_path.exists())
                .unwrap_or(false);
        }
        let main = self
            .config_path()
            .map(|p| backup_path(&p).exists())
            .unwrap_or(false);
        let auth = self
            .opencode_auth_path()
            .map(|p| backup_path(&p).exists())
            .unwrap_or(false);
        let zcode_cli = self
            .zcode_cli_config_path()
            .map(|p| backup_path(&p).exists())
            .unwrap_or(false);
        let pi_settings = self
            .pi_settings_path()
            .map(|p| backup_path(&p).exists())
            .unwrap_or(false);
        let harness_credentials = self
            .deepseek_harness_credentials_path()
            .map(|p| backup_path(&p).exists())
            .unwrap_or(false);
        main || auth || zcode_cli || pi_settings || harness_credentials
    }


    /// 备份 + 写入。返回写入的配置文件路径。
    pub(in crate::commands::platforms) fn apply(&self, p: &Provider) -> Result<PathBuf, String> {
        let path = self
            .config_path()
            .ok_or_else(|| "无法定位用户主目录".to_string())?;
        // 确保父目录存在（工具装了但还没生成过配置文件的情况）。
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("创建配置目录失败: {e}"))?;
        }
        // 幂等备份：仅当原文件存在且备份不存在时创建——保留「接管前」的原始状态。
        ensure_backup(&path)?;

        match self {
            Platform::Antigravity => self.apply_antigravity(&path, p)?,
            Platform::AntigravityIde => self.apply_antigravity_ide(&path, p)?,
            Platform::ClaudeDesktop => {
                crate::commands::claude_desktop::apply_claude_desktop_sync(None)?;
            }
            Platform::ClaudeCode => self.apply_claude(&path, p)?,
            Platform::Codex => self.apply_codex(&path, p)?,
            Platform::CodeBuddy => self.apply_codebuddy(&path, p)?,
            Platform::Grok => self.apply_grok(&path, p)?,
            Platform::OpenCode => self.apply_opencode(&path, p)?,
            Platform::WorkBuddy => self.apply_workbuddy(&path, p)?,
            Platform::ZCode => self.apply_zcode(&path, p)?,
            Platform::Pi => self.apply_pi(&path, p)?,
            Platform::Hermes => write_hermes_managed_models(&path, &hermes_entries_from_provider(p))?,
            Platform::DeepSeekHarness => {
                let credentials = self
                    .deepseek_harness_credentials_path()
                    .ok_or("无法定位 DeepSeek Harness 凭据路径")?;
                write_harness_managed_models(
                    &path,
                    &credentials,
                    &harness_entries_from_provider(p),
                )?
            }
        }
        Ok(path)
    }

}
