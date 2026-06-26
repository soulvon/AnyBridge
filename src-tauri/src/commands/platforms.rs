// platforms.rs — 「更多平台」：直接接管 Claude Code / Codex / CodeBuddy / OpenCode / ZCode 等 API 端点。
//
// 与 Windsurf/Devin 的「http.proxy 代理接入 + 常驻 sidecar」模式不同，这里是
// 「直接改 CLI 工具自己的配置文件」：从 providerStore 选一个供应商，把其
// base_url / api_key / model 写入目标工具的配置文件，下次启动工具即生效，
// 不依赖任何常驻进程。
//
// 关键约束：
//   1. 只改我们关心的字段，保留文件内其余所有用户配置。
//   2. 首次接管前幂等备份到 `<file>.byok-bak`，「还原」即回到接管前状态。
//   3. 这是持久切换——退出 AnyBridge 不回滚（不接入 lib.rs 的 ExitRequested）。
//
// 复用：commands::write_atomic（原子写）、ide_config::parse_object（json5 容错解析）。

use serde::Serialize;
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use toml_edit::{value, DocumentMut, Item, Table};

use super::config::{
    read_provider_store, write_provider_store, ClaudeCodeConfig, OpenCodeConfig, PlatformState,
    Provider, ProviderStore,
};

const PLATFORM_CLAUDE_CODE: &str = "claude-code";
const PLATFORM_CODEX: &str = "codex";
const PLATFORM_CODEBUDDY: &str = "codebuddy";
const PLATFORM_OPENCODE: &str = "opencode";
const PLATFORM_WORKBUDDY: &str = "workbuddy";
const PLATFORM_ZCODE: &str = "zcode";
const ABSENT_BACKUP_SENTINEL: &[u8] = b"__IDE_BYOK_ORIGINAL_FILE_ABSENT__\n";
const ZCODE_PROVIDER_ID: &str = "AnyBridge";

// ─── 返回给前端的结构 ──────────────────────────────────────────

#[derive(Serialize)]
pub struct PlatformInfo {
    pub id: String,
    #[serde(rename = "displayName")]
    pub display_name: String,
    pub vendor: String,
    /// 该平台需要的协议格式："anthropic"（Claude Code）/ "openai"（Codex）
    #[serde(rename = "requiredApiFormat")]
    pub required_api_format: String,
    /// 是否检测到工具（配置目录存在）
    pub installed: bool,
    #[serde(rename = "configPath")]
    pub config_path: String,
    #[serde(rename = "backupExists")]
    pub backup_exists: bool,
    #[serde(rename = "currentProviderId")]
    pub current_provider_id: Option<String>,
    #[serde(rename = "currentProviderName")]
    pub current_provider_name: Option<String>,
    #[serde(rename = "managedByAnyBridge")]
    pub managed_by_any_bridge: bool,
    #[serde(rename = "appliedAt")]
    pub applied_at: Option<String>,
    #[serde(rename = "liveProviderIds")]
    pub live_provider_ids: Vec<String>,
    #[serde(rename = "codexConfig")]
    pub codex_config: Option<CodexConfigInfo>,
    #[serde(rename = "claudeConfig")]
    pub claude_config: Option<ClaudeConfigInfo>,
    /// 检测/读取过程中的错误（如配置解析失败）
    pub error: Option<String>,
}

#[derive(Serialize, Clone)]
pub struct ClaudeConfigInfo {
    pub model: Option<String>,
    #[serde(rename = "baseUrl")]
    pub base_url: Option<String>,
    #[serde(rename = "hasAuthToken")]
    pub has_auth_token: bool,
    #[serde(rename = "authTokenMasked")]
    pub auth_token_masked: Option<String>,
    #[serde(rename = "isOfficial")]
    pub is_official: bool,
    #[serde(rename = "managedByAnyBridge")]
    pub managed_by_any_bridge: bool,
}

#[derive(Serialize, Clone)]
pub struct CodexConfigInfo {
    pub model: Option<String>,
    #[serde(rename = "modelProviderId")]
    pub model_provider_id: Option<String>,
    #[serde(rename = "providerName")]
    pub provider_name: Option<String>,
    #[serde(rename = "baseUrl")]
    pub base_url: Option<String>,
    #[serde(rename = "wireApi")]
    pub wire_api: Option<String>,
    #[serde(rename = "hasBearerToken")]
    pub has_bearer_token: bool,
    #[serde(rename = "bearerTokenMasked")]
    pub bearer_token_masked: Option<String>,
    #[serde(rename = "bearerToken")]
    pub bearer_token: Option<String>,
    #[serde(rename = "isOfficial")]
    pub is_official: bool,
    #[serde(rename = "managedByAnyBridge")]
    pub managed_by_any_bridge: bool,
}

#[derive(Serialize)]
pub struct SwitchResult {
    pub ok: bool,
    pub message: String,
    #[serde(rename = "configPath")]
    pub config_path: String,
    #[serde(rename = "backupPath")]
    pub backup_path: String,
}

// ─── 平台抽象 ──────────────────────────────────────────────────

enum Platform {
    ClaudeCode,
    Codex,
    CodeBuddy,
    OpenCode,
    WorkBuddy,
    ZCode,
}

impl Platform {
    fn from_id(id: &str) -> Option<Self> {
        match id {
            PLATFORM_CLAUDE_CODE => Some(Platform::ClaudeCode),
            PLATFORM_CODEX => Some(Platform::Codex),
            PLATFORM_CODEBUDDY => Some(Platform::CodeBuddy),
            PLATFORM_OPENCODE => Some(Platform::OpenCode),
            PLATFORM_WORKBUDDY => Some(Platform::WorkBuddy),
            PLATFORM_ZCODE => Some(Platform::ZCode),
            _ => None,
        }
    }

    fn id(&self) -> &'static str {
        match self {
            Platform::ClaudeCode => PLATFORM_CLAUDE_CODE,
            Platform::Codex => PLATFORM_CODEX,
            Platform::CodeBuddy => PLATFORM_CODEBUDDY,
            Platform::OpenCode => PLATFORM_OPENCODE,
            Platform::WorkBuddy => PLATFORM_WORKBUDDY,
            Platform::ZCode => PLATFORM_ZCODE,
        }
    }

    fn display_name(&self) -> &'static str {
        match self {
            Platform::ClaudeCode => "Claude Code",
            Platform::Codex => "Codex",
            Platform::CodeBuddy => "CodeBuddy",
            Platform::OpenCode => "OpenCode",
            Platform::WorkBuddy => "WorkBuddy",
            Platform::ZCode => "ZCode",
        }
    }

    fn vendor(&self) -> &'static str {
        match self {
            Platform::ClaudeCode => "Anthropic",
            Platform::Codex => "OpenAI",
            Platform::CodeBuddy => "Tencent Cloud",
            Platform::OpenCode => "OpenCode",
            Platform::WorkBuddy => "Tencent Cloud",
            Platform::ZCode => "Z.AI",
        }
    }

    /// 该平台需要的中转站协议格式。
    fn required_api_format(&self) -> &'static str {
        match self {
            Platform::ClaudeCode => "anthropic",
            Platform::Codex
            | Platform::CodeBuddy
            | Platform::OpenCode
            | Platform::WorkBuddy
            | Platform::ZCode => "openai",
        }
    }

    /// 配置目录（用于检测是否安装）。
    fn config_dir(&self) -> Option<PathBuf> {
        let home = dirs::home_dir()?;
        Some(match self {
            Platform::ClaudeCode => home.join(".claude"),
            Platform::Codex => home.join(".codex"),
            Platform::CodeBuddy => home.join(".codebuddy"),
            Platform::OpenCode => home.join(".config").join("opencode"),
            Platform::WorkBuddy => home.join(".workbuddy"),
            Platform::ZCode => home.join(".zcode"),
        })
    }

    /// 配置文件路径。
    fn config_path(&self) -> Option<PathBuf> {
        let dir = self.config_dir()?;
        Some(match self {
            Platform::ClaudeCode => dir.join("settings.json"),
            Platform::Codex => dir.join("config.toml"),
            Platform::CodeBuddy => dir.join("models.json"),
            Platform::OpenCode => {
                let json = dir.join("opencode.json");
                let jsonc = dir.join("opencode.jsonc");
                if !json.exists() && jsonc.exists() {
                    jsonc
                } else {
                    json
                }
            }
            Platform::WorkBuddy => dir.join("models.json"),
            Platform::ZCode => dir.join("v2").join("config.json"),
        })
    }

    fn opencode_auth_path(&self) -> Option<PathBuf> {
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

    fn zcode_cli_config_path(&self) -> Option<PathBuf> {
        if !matches!(self, Platform::ZCode) {
            return None;
        }
        let home = dirs::home_dir()?;
        Some(home.join(".zcode").join("cli").join("config.json"))
    }

    /// 检测工具是否安装：配置目录存在即视为已安装（文件可能尚未生成）。
    fn detect_installed(&self) -> bool {
        if self.config_dir().map(|d| d.exists()).unwrap_or(false) {
            return true;
        }
        match self {
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
            _ => false,
        }
    }

    fn backup_exists(&self) -> bool {
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
        main || auth || zcode_cli
    }

    /// 生成将写入的配置片段（预览用，token 脱敏），不落盘。
    fn preview(&self, p: &Provider) -> Result<String, String> {
        match self {
            Platform::ClaudeCode => {
                let base = claude_base_url(p);
                let model = p.default_model.trim();
                let masked = mask_key(&p.api_key);
                let preview = serde_json::json!({
                    "env": {
                        "ANTHROPIC_BASE_URL": base,
                        "ANTHROPIC_AUTH_TOKEN": masked,
                        "ANTHROPIC_MODEL": model,
                        "ANTHROPIC_DEFAULT_HAIKU_MODEL": model,
                        "ANTHROPIC_DEFAULT_SONNET_MODEL": model,
                        "ANTHROPIC_DEFAULT_OPUS_MODEL": model,
                    }
                });
                serde_json::to_string_pretty(&preview).map_err(|e| e.to_string())
            }
            Platform::Codex => {
                let base = codex_base_url(p);
                let model = toml_escape(p.default_model.trim());
                let masked = mask_key(&p.api_key);
                let name = toml_escape(&p.name);
                Ok(format!(
                    "model = \"{model}\"\nmodel_provider = \"byok\"\n\n[model_providers.byok]\nname = \"{name}\"\nbase_url = \"{base}\"\nwire_api = \"responses\"\nrequires_openai_auth = true\nexperimental_bearer_token = \"{masked}\""
                ))
            }
            Platform::CodeBuddy => {
                let model_id = codebuddy_model_id(p);
                let preview_model = codebuddy_model_entry(p, &mask_key(&p.api_key));
                let preview = serde_json::json!({
                    "models": [preview_model],
                    "availableModels": format!("如果已配置且非空，将追加 \"{}\"", model_id),
                });
                serde_json::to_string_pretty(&preview).map_err(|e| e.to_string())
            }
            Platform::OpenCode => {
                let preview = opencode_preview(p);
                serde_json::to_string_pretty(&preview).map_err(|e| e.to_string())
            }
            Platform::WorkBuddy => {
                let model_id = workbuddy_model_id(p);
                let preview_model = workbuddy_model_entry(p, &mask_key(&p.api_key));
                let preview = serde_json::json!({
                    "models": [preview_model],
                    "availableModels": format!("如果已配置且非空，将追加 \"{}\"", model_id),
                });
                serde_json::to_string_pretty(&preview).map_err(|e| e.to_string())
            }
            Platform::ZCode => {
                let preview = zcode_preview(p, &mask_key(&p.api_key));
                serde_json::to_string_pretty(&preview).map_err(|e| e.to_string())
            }
        }
    }

    /// 备份 + 写入。返回写入的配置文件路径。
    fn apply(&self, p: &Provider) -> Result<PathBuf, String> {
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
            Platform::ClaudeCode => self.apply_claude(&path, p)?,
            Platform::Codex => self.apply_codex(&path, p)?,
            Platform::CodeBuddy => self.apply_codebuddy(&path, p)?,
            Platform::OpenCode => self.apply_opencode(&path, p)?,
            Platform::WorkBuddy => self.apply_workbuddy(&path, p)?,
            Platform::ZCode => self.apply_zcode(&path, p)?,
        }
        Ok(path)
    }

    fn apply_claude(&self, path: &PathBuf, p: &Provider) -> Result<(), String> {
        let raw = if path.exists() {
            fs::read_to_string(path).map_err(|e| e.to_string())?
        } else {
            String::new()
        };
        // 复用 ide_config 的 json5 容错解析（支持注释/尾逗号）。
        let mut obj = super::ide_config::parse_object(&raw)?;

        let env = obj
            .entry("env")
            .or_insert_with(|| Value::Object(Map::new()));
        let env_obj = env
            .as_object_mut()
            .ok_or_else(|| "settings.json 的 env 字段不是对象".to_string())?;

        let base = claude_base_url(p);
        let model = p.default_model.trim().to_string();
        env_obj.insert("ANTHROPIC_BASE_URL".into(), Value::String(base));
        env_obj.insert(
            "ANTHROPIC_AUTH_TOKEN".into(),
            Value::String(p.api_key.clone()),
        );
        env_obj.insert("ANTHROPIC_MODEL".into(), Value::String(model.clone()));
        env_obj.insert(
            "ANTHROPIC_DEFAULT_HAIKU_MODEL".into(),
            Value::String(model.clone()),
        );
        env_obj.insert(
            "ANTHROPIC_DEFAULT_SONNET_MODEL".into(),
            Value::String(model.clone()),
        );
        env_obj.insert("ANTHROPIC_DEFAULT_OPUS_MODEL".into(), Value::String(model));

        let json = serde_json::to_string_pretty(&Value::Object(obj)).map_err(|e| e.to_string())?;
        super::write_atomic(path, json.as_bytes())
    }

    fn apply_claude_official(&self, path: &PathBuf) -> Result<(), String> {
        if !path.exists() {
            return Ok(());
        }

        let raw = fs::read_to_string(path).map_err(|e| e.to_string())?;
        if raw.trim().is_empty() {
            return Ok(());
        }

        let mut obj = super::ide_config::parse_object(&raw)?;
        let remove_env = if let Some(env) = obj.get_mut("env").and_then(Value::as_object_mut) {
            for key in [
                "ANTHROPIC_BASE_URL",
                "ANTHROPIC_AUTH_TOKEN",
                "ANTHROPIC_API_KEY",
                "ANTHROPIC_MODEL",
                "ANTHROPIC_DEFAULT_HAIKU_MODEL",
                "ANTHROPIC_DEFAULT_SONNET_MODEL",
                "ANTHROPIC_DEFAULT_OPUS_MODEL",
            ] {
                env.remove(key);
            }
            env.is_empty()
        } else {
            false
        };

        if remove_env {
            obj.remove("env");
        }

        let json = serde_json::to_string_pretty(&Value::Object(obj)).map_err(|e| e.to_string())?;
        super::write_atomic(path, json.as_bytes())
    }

    fn apply_codex(&self, path: &PathBuf, p: &Provider) -> Result<(), String> {
        let raw = if path.exists() {
            fs::read_to_string(path).map_err(|e| e.to_string())?
        } else {
            String::new()
        };
        // toml_edit 保留式编辑：只改我们的字段，mcp_servers/desktop/projects 等原样保留。
        let mut doc = raw
            .parse::<DocumentMut>()
            .map_err(|e| format!("config.toml 解析失败: {e}"))?;

        let base = codex_base_url(p);
        let model = p.default_model.trim();

        if !model.is_empty() {
            doc["model"] = value(model);
        }
        doc["model_provider"] = value("byok");

        // 确保 [model_providers] 是表，再写入 byok 子表。
        let providers = doc
            .entry("model_providers")
            .or_insert(Item::Table(Table::new()))
            .as_table_mut()
            .ok_or_else(|| "config.toml 的 model_providers 不是表".to_string())?;
        // 让 [model_providers] 表头在已有子表时不重复输出。
        providers.set_implicit(true);

        let byok = providers
            .entry("byok")
            .or_insert(Item::Table(Table::new()))
            .as_table_mut()
            .ok_or_else(|| "config.toml 的 model_providers.byok 不是表".to_string())?;
        byok["name"] = value(p.name.clone());
        byok["base_url"] = value(base);
        byok["wire_api"] = value("responses");
        byok["requires_openai_auth"] = value(true);
        byok["experimental_bearer_token"] = value(p.api_key.clone());

        super::write_atomic(path, doc.to_string().as_bytes())
    }

    fn apply_codex_official(&self, path: &PathBuf) -> Result<(), String> {
        let raw = if path.exists() {
            fs::read_to_string(path).map_err(|e| e.to_string())?
        } else {
            String::new()
        };
        let mut doc = raw
            .parse::<DocumentMut>()
            .map_err(|e| format!("config.toml 解析失败: {e}"))?;

        // OpenAI Official uses Codex's built-in provider and auth.json login.
        // Keep common settings, but remove the active third-party pointer.
        doc.as_table_mut().remove("model");
        doc.as_table_mut().remove("model_provider");

        let providers_empty = doc["model_providers"]
            .as_table_mut()
            .map(|providers| {
                providers.remove("byok");
                providers.is_empty()
            })
            .unwrap_or(false);
        if providers_empty {
            doc.as_table_mut().remove("model_providers");
        }

        super::write_atomic(path, doc.to_string().as_bytes())
    }

    fn apply_codebuddy(&self, path: &PathBuf, p: &Provider) -> Result<(), String> {
        let raw = if path.exists() {
            fs::read_to_string(path).map_err(|e| e.to_string())?
        } else {
            String::new()
        };
        let mut obj = parse_json_object(&raw, "models.json")?;

        let model_id = codebuddy_model_id(p);
        let new_model = codebuddy_model_entry(p, &p.api_key);

        upsert_models_json_entry(&mut obj, &model_id, new_model)?;

        let json = serde_json::to_string_pretty(&Value::Object(obj)).map_err(|e| e.to_string())?;
        super::write_atomic(path, json.as_bytes())
    }

    fn apply_workbuddy(&self, path: &PathBuf, p: &Provider) -> Result<(), String> {
        let raw = if path.exists() {
            fs::read_to_string(path).map_err(|e| e.to_string())?
        } else {
            String::new()
        };
        let mut obj = parse_json_object(&raw, "models.json")?;

        let model_id = workbuddy_model_id(p);
        let new_model = workbuddy_model_entry(p, &p.api_key);

        upsert_models_json_entry(&mut obj, &model_id, new_model)?;

        let json = serde_json::to_string_pretty(&Value::Object(obj)).map_err(|e| e.to_string())?;
        super::write_atomic(path, json.as_bytes())
    }

    fn apply_opencode(&self, path: &PathBuf, p: &Provider) -> Result<(), String> {
        let raw = if path.exists() {
            fs::read_to_string(path).map_err(|e| e.to_string())?
        } else {
            String::new()
        };
        let mut obj = parse_json_object(&raw, "opencode.json")?;

        obj.entry("$schema")
            .or_insert_with(|| Value::String("https://opencode.ai/config.json".to_string()));

        let provider_value = obj
            .entry("provider")
            .or_insert_with(|| Value::Object(Map::new()));
        let provider_obj = provider_value
            .as_object_mut()
            .ok_or_else(|| "opencode.json 的 provider 字段不是对象".to_string())?;
        provider_obj.insert(p.id.clone(), opencode_provider_entry(p));

        let json = serde_json::to_string_pretty(&Value::Object(obj)).map_err(|e| e.to_string())?;
        super::write_atomic(path, json.as_bytes())
    }

    fn apply_zcode(&self, path: &PathBuf, p: &Provider) -> Result<(), String> {
        apply_zcode_config_file(path, p)?;

        if let Some(cli_path) = self.zcode_cli_config_path() {
            ensure_parent_dir(&cli_path)?;
            ensure_backup(&cli_path)?;
            apply_zcode_config_file(&cli_path, p)?;
        }

        Ok(())
    }

    /// 从 `.byok-bak` 还原；无备份时不动文件（返回 false）。
    fn restore(&self) -> Result<bool, String> {
        let path = self
            .config_path()
            .ok_or_else(|| "无法定位用户主目录".to_string())?;

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
            return Ok(restored);
        }

        restore_one_file(&path)
    }
}

// ─── 辅助函数 ──────────────────────────────────────────────────

fn upsert_models_json_entry(
    obj: &mut Map<String, Value>,
    model_id: &str,
    new_model: Value,
) -> Result<(), String> {
    let models = obj
        .entry("models")
        .or_insert_with(|| Value::Array(Vec::new()));
    let models_arr = models
        .as_array_mut()
        .ok_or_else(|| "models.json 的 models 字段不是数组".to_string())?;

    let mut replaced = false;
    for item in models_arr.iter_mut() {
        if item.get("id").and_then(Value::as_str) == Some(model_id) {
            *item = new_model.clone();
            replaced = true;
            break;
        }
    }
    if !replaced {
        models_arr.push(new_model);
    }

    if let Some(available) = obj.get_mut("availableModels") {
        let arr = available
            .as_array_mut()
            .ok_or_else(|| "models.json 的 availableModels 字段不是数组".to_string())?;
        if !arr.is_empty() && !arr.iter().any(|v| v.as_str() == Some(model_id)) {
            arr.push(Value::String(model_id.to_string()));
        }
    }

    Ok(())
}

fn backup_path(path: &PathBuf) -> PathBuf {
    let mut bak = path.clone();
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "config".into());
    bak.set_file_name(format!("{name}.byok-bak"));
    bak
}

/// 幂等备份：原文件存在则复制原文件；原文件不存在则写入缺失标记，
/// 这样还原时能删除由 AnyBridge 首次创建的配置文件。
fn ensure_backup(path: &PathBuf) -> Result<(), String> {
    let bak = backup_path(path);
    if bak.exists() {
        return Ok(());
    }
    let content = if path.exists() {
        fs::read(path).map_err(|e| e.to_string())?
    } else {
        ABSENT_BACKUP_SENTINEL.to_vec()
    };
    super::write_atomic(&bak, &content).map_err(|e| format!("备份失败: {e}"))
}

fn ensure_parent_dir(path: &PathBuf) -> Result<(), String> {
    let Some(parent) = path.parent() else {
        return Err("配置路径无父目录".to_string());
    };
    fs::create_dir_all(parent).map_err(|e| format!("创建配置目录失败: {e}"))
}

fn restore_one_file(path: &PathBuf) -> Result<bool, String> {
    let bak = backup_path(path);
    if !bak.exists() {
        return Ok(false);
    }
    let content = fs::read(&bak).map_err(|e| e.to_string())?;
    if content == ABSENT_BACKUP_SENTINEL {
        if path.exists() {
            fs::remove_file(path).map_err(|e| e.to_string())?;
        }
        let _ = fs::remove_file(&bak);
        return Ok(true);
    }
    ensure_parent_dir(path)?;
    super::write_atomic(path, &content)?;
    let _ = fs::remove_file(&bak);
    Ok(true)
}

fn parse_json_object(raw: &str, label: &str) -> Result<Map<String, Value>, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(Map::new());
    }
    let value: Value = json5::from_str(trimmed).map_err(|e| format!("{label} 解析失败: {e}"))?;
    match value {
        Value::Object(m) => Ok(m),
        _ => Err(format!("{label} 顶层不是对象")),
    }
}

fn app_data_dir(name: &str) -> Option<PathBuf> {
    let mut dir = dirs::data_dir()?;
    dir.push(name);
    Some(dir)
}

fn now_epoch_secs() -> String {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
        .to_string()
}

fn resolve_platform_config(
    plat: &Platform,
    store: &ProviderStore,
    id: &str,
) -> Result<Provider, String> {
    if matches!(plat, Platform::ClaudeCode) {
        return store
            .claude_code_configs
            .iter()
            .find(|config| config.id == id)
            .cloned()
            .map(Provider::from)
            .ok_or_else(|| format!("Claude Code 配置不存在: {id}"));
    }

    if matches!(plat, Platform::Codex) {
        return store
            .codex_configs
            .iter()
            .find(|config| config.id == id)
            .cloned()
            .map(Provider::from)
            .ok_or_else(|| format!("Codex 配置不存在: {id}"));
    }

    if matches!(plat, Platform::OpenCode) {
        return store
            .opencode_configs
            .iter()
            .find(|config| config.id == id)
            .cloned()
            .map(Provider::from)
            .ok_or_else(|| format!("OpenCode 配置不存在: {id}"));
    }

    store
        .providers
        .iter()
        .find(|p| p.id == id)
        .cloned()
        .ok_or_else(|| format!("供应商不存在: {id}"))
}

/// 规范化 URL：补 https://，去尾部斜杠。
fn normalize_url(url: &str) -> String {
    let raw = url.trim();
    let raw = if raw.starts_with("http://") || raw.starts_with("https://") {
        raw.to_string()
    } else {
        format!("https://{raw}")
    };
    raw.trim_end_matches('/').to_string()
}

fn provider_endpoint_url(p: &Provider) -> String {
    let base = normalize_url(&p.api_host);
    let Some(path) = p.api_path.as_deref() else {
        return base;
    };
    let path = path.trim();
    if path.is_empty() || path == "/" {
        return base;
    }
    format!(
        "{}/{}",
        base.trim_end_matches('/'),
        path.trim_start_matches('/')
    )
    .trim_end_matches('/')
    .to_string()
}

fn strip_suffix_case_insensitive(value: &str, suffix: &str) -> Option<String> {
    let lower = value.to_ascii_lowercase();
    if lower.ends_with(suffix) {
        let keep_len = value.len().saturating_sub(suffix.len());
        Some(value[..keep_len].trim_end_matches('/').to_string())
    } else {
        None
    }
}

fn strip_first_matching_suffix(value: &str, suffixes: &[&str]) -> String {
    for suffix in suffixes {
        if let Some(stripped) = strip_suffix_case_insensitive(value, suffix) {
            return stripped;
        }
    }
    value.to_string()
}

/// Claude Code 的 base_url：Claude Code 会自动加 /v1/messages，base 不应带 /v1。
fn claude_base_url(p: &Provider) -> String {
    strip_first_matching_suffix(
        &provider_endpoint_url(p),
        &["/v1/messages", "/messages", "/v1"],
    )
}

/// Codex 的 base_url：OpenAI 风格，需要以 /v1 结尾。
fn codex_base_url(p: &Provider) -> String {
    let base = strip_first_matching_suffix(
        &provider_endpoint_url(p),
        &["/chat/completions", "/responses"],
    );
    if base.to_ascii_lowercase().ends_with("/v1") {
        base
    } else {
        format!("{base}/v1")
    }
}

fn toml_item_string(item: &Item) -> Option<String> {
    item.as_value()
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
}

fn toml_table_string(table: &Table, key: &str) -> Option<String> {
    table.get(key).and_then(toml_item_string)
}

fn read_codex_config_info(path: &PathBuf) -> Result<Option<CodexConfigInfo>, String> {
    if !path.exists() {
        return Ok(None);
    }

    let raw = fs::read_to_string(path).map_err(|e| e.to_string())?;
    if raw.trim().is_empty() {
        return Ok(Some(CodexConfigInfo {
            model: None,
            model_provider_id: None,
            provider_name: Some("OpenAI 官方".to_string()),
            base_url: None,
            wire_api: Some("responses".to_string()),
            has_bearer_token: false,
            bearer_token_masked: None,
            bearer_token: None,
            is_official: true,
            managed_by_any_bridge: false,
        }));
    }

    let doc = raw
        .parse::<DocumentMut>()
        .map_err(|e| format!("config.toml 解析失败: {e}"))?;

    let model = doc.get("model").and_then(toml_item_string);
    let model_provider_id = doc.get("model_provider").and_then(toml_item_string);

    let provider_table = model_provider_id.as_ref().and_then(|provider_id| {
        doc.get("model_providers")
            .and_then(Item::as_table)
            .and_then(|providers| providers.get(provider_id))
            .and_then(Item::as_table)
    });

    let provider_name = provider_table.and_then(|table| toml_table_string(table, "name"));
    let base_url = provider_table.and_then(|table| toml_table_string(table, "base_url"));
    let wire_api = provider_table.and_then(|table| toml_table_string(table, "wire_api"));
    let bearer_token = provider_table
        .and_then(|table| toml_table_string(table, "experimental_bearer_token"))
        .filter(|token| !token.trim().is_empty());
    let has_bearer_token = bearer_token.is_some();
    let bearer_token_masked = bearer_token.as_deref().map(mask_key);
    let model_provider_normalized = model_provider_id
        .as_deref()
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();
    let is_official = model_provider_normalized.is_empty()
        || model_provider_normalized == "openai"
        || (provider_table
            .and_then(|table| toml_table_string(table, "name"))
            .map(|name| name.trim().eq_ignore_ascii_case("openai"))
            .unwrap_or(false)
            && base_url.is_none()
            && !has_bearer_token);
    let managed_by_any_bridge = model_provider_id.as_deref() == Some("byok");

    Ok(Some(CodexConfigInfo {
        model,
        model_provider_id,
        provider_name,
        base_url,
        wire_api,
        has_bearer_token,
        bearer_token_masked,
        bearer_token,
        is_official,
        managed_by_any_bridge,
    }))
}

fn read_opencode_live_provider_ids(path: &PathBuf) -> Result<Vec<String>, String> {
    if !path.exists() {
        return Ok(Vec::new());
    }
    let raw = fs::read_to_string(path).map_err(|e| e.to_string())?;
    let obj = parse_json_object(&raw, "opencode.json")?;
    let Some(provider_obj) = obj.get("provider").and_then(Value::as_object) else {
        return Ok(Vec::new());
    };

    let mut ids: Vec<String> = provider_obj
        .keys()
        .filter(|id| !id.trim().is_empty())
        .cloned()
        .collect();
    ids.sort();
    Ok(ids)
}

fn read_opencode_active_model_provider_id(path: &PathBuf) -> Result<Option<String>, String> {
    if !path.exists() {
        return Ok(None);
    }
    let raw = fs::read_to_string(path).map_err(|e| e.to_string())?;
    let obj = parse_json_object(&raw, "opencode.json")?;
    Ok(obj
        .get("model")
        .and_then(Value::as_str)
        .and_then(|model| model.split('/').next())
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .map(ToString::to_string))
}

fn json_string(map: &Map<String, Value>, key: &str) -> Option<String> {
    map.get(key)
        .and_then(Value::as_str)
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

fn first_json_string(map: Option<&Map<String, Value>>, keys: &[&str]) -> Option<String> {
    let map = map?;
    keys.iter().find_map(|key| json_string(map, key))
}

fn read_claude_config_info(path: &PathBuf) -> Result<Option<ClaudeConfigInfo>, String> {
    if !path.exists() {
        return Ok(None);
    }

    let raw = fs::read_to_string(path).map_err(|e| e.to_string())?;
    if raw.trim().is_empty() {
        return Ok(Some(ClaudeConfigInfo {
            model: None,
            base_url: None,
            has_auth_token: false,
            auth_token_masked: None,
            is_official: true,
            managed_by_any_bridge: false,
        }));
    }

    let obj = parse_json_object(&raw, "settings.json")?;
    let env = obj.get("env").and_then(Value::as_object);
    let base_url = first_json_string(env, &["ANTHROPIC_BASE_URL"]);
    let auth_token = first_json_string(
        env,
        &[
            "ANTHROPIC_AUTH_TOKEN",
            "ANTHROPIC_API_KEY",
            "OPENROUTER_API_KEY",
            "GOOGLE_API_KEY",
        ],
    );
    let model = first_json_string(
        env,
        &[
            "ANTHROPIC_MODEL",
            "ANTHROPIC_DEFAULT_SONNET_MODEL",
            "ANTHROPIC_DEFAULT_OPUS_MODEL",
            "ANTHROPIC_DEFAULT_HAIKU_MODEL",
        ],
    );
    let has_auth_token = auth_token.is_some();
    let is_official = base_url.is_none() && auth_token.is_none();

    Ok(Some(ClaudeConfigInfo {
        model,
        base_url,
        has_auth_token,
        auth_token_masked: auth_token.as_deref().map(mask_key),
        is_official,
        managed_by_any_bridge: false,
    }))
}

fn claude_settings_from_config(config: &ClaudeCodeConfig, mask_token: bool) -> Value {
    if let Some(settings) = config.settings_config.as_ref() {
        let mut out = settings.clone();
        if mask_token {
            if let Some(value) = out.get_mut("apiKey") {
                if let Some(masked) = value.as_str().map(mask_key) {
                    *value = Value::String(masked);
                }
            }
            if let Some(env) = out.get_mut("env").and_then(Value::as_object_mut) {
                for key in [
                    "ANTHROPIC_AUTH_TOKEN",
                    "ANTHROPIC_API_KEY",
                    "OPENROUTER_API_KEY",
                    "GOOGLE_API_KEY",
                ] {
                    if let Some(value) = env.get_mut(key) {
                        if let Some(masked) = value.as_str().map(mask_key) {
                            *value = Value::String(masked);
                        }
                    }
                }
            }
        }
        return out;
    }

    let provider = Provider::from(config.clone());
    let base = claude_base_url(&provider);
    let model = provider.default_model.trim();
    let token = if mask_token {
        mask_key(&provider.api_key)
    } else {
        provider.api_key.clone()
    };

    serde_json::json!({
        "$schema": "https://json.schemastore.org/claude-code-settings.json",
        "includeCoAuthoredBy": false,
        "env": {
            "ANTHROPIC_BASE_URL": base,
            "ANTHROPIC_AUTH_TOKEN": token,
            "ANTHROPIC_MODEL": model,
            "ANTHROPIC_DEFAULT_HAIKU_MODEL": model,
            "ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME": model,
            "ANTHROPIC_DEFAULT_SONNET_MODEL": model,
            "ANTHROPIC_DEFAULT_SONNET_MODEL_NAME": model,
            "ANTHROPIC_DEFAULT_OPUS_MODEL": model,
            "ANTHROPIC_DEFAULT_OPUS_MODEL_NAME": model,
            "ANTHROPIC_DEFAULT_FABLE_MODEL": model,
            "ANTHROPIC_DEFAULT_FABLE_MODEL_NAME": model,
        },
        "permissions": {},
        "hooks": {},
        "mcpServers": {},
    })
}

fn merge_json_object(target: &mut Map<String, Value>, source: &Map<String, Value>) {
    for (key, source_value) in source {
        match (target.get_mut(key), source_value) {
            (Some(Value::Object(target_obj)), Value::Object(source_obj)) => {
                merge_json_object(target_obj, source_obj);
            }
            _ => {
                target.insert(key.clone(), source_value.clone());
            }
        }
    }
}

fn apply_claude_config_file(path: &PathBuf, config: &ClaudeCodeConfig) -> Result<(), String> {
    let raw = if path.exists() {
        fs::read_to_string(path).map_err(|e| e.to_string())?
    } else {
        String::new()
    };
    let mut obj = super::ide_config::parse_object(&raw)?;
    let settings = claude_settings_from_config(config, false);
    let settings_obj = settings
        .as_object()
        .ok_or_else(|| "Claude Code 配置 JSON 顶层必须是对象".to_string())?;
    merge_json_object(&mut obj, settings_obj);
    let json = serde_json::to_string_pretty(&Value::Object(obj)).map_err(|e| e.to_string())?;
    super::write_atomic(path, json.as_bytes())
}

fn claude_compare_base_url(value: &str) -> String {
    strip_first_matching_suffix(
        value.trim().trim_end_matches('/'),
        &["/v1/messages", "/messages", "/v1"],
    )
    .trim_end_matches('/')
    .to_ascii_lowercase()
}

fn claude_provider_matches_config(config: &ClaudeConfigInfo, provider: &Provider) -> bool {
    let Some(current_base) = config.base_url.as_deref() else {
        return false;
    };
    let target_base = claude_compare_base_url(&claude_base_url(provider));
    let current_base = claude_compare_base_url(current_base);
    let same_base = !target_base.is_empty() && target_base == current_base;
    let same_model = config
        .model
        .as_deref()
        .map(|model| provider.default_model.trim().is_empty() || model == provider.default_model)
        .unwrap_or(true);

    same_base && same_model
}

fn codebuddy_model_id(p: &Provider) -> String {
    let model = p.default_model.trim();
    if model.is_empty() {
        format!("byok-{}", sanitize_codebuddy_id(&p.id))
    } else {
        model.to_string()
    }
}

fn sanitize_codebuddy_id(value: &str) -> String {
    let mut out = String::new();
    for ch in value.trim().chars() {
        if ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.' | '/' | ':') {
            out.push(ch);
        } else if ch.is_whitespace() {
            out.push('-');
        }
    }
    if out.is_empty() {
        "model".to_string()
    } else {
        out
    }
}

fn codebuddy_model_entry(p: &Provider, api_key: &str) -> Value {
    let model_id = codebuddy_model_id(p);
    let display_name = if p.name.trim().is_empty() {
        model_id.clone()
    } else if p.default_model.trim().is_empty() {
        p.name.trim().to_string()
    } else {
        format!("{} · {}", p.name.trim(), p.default_model.trim())
    };

    let caps = p
        .model_caps
        .get(p.default_model.trim())
        .cloned()
        .unwrap_or_default();

    serde_json::json!({
        "id": model_id,
        "name": display_name,
        "vendor": p.name.trim(),
        "apiKey": api_key,
        "maxInputTokens": 128000,
        "maxOutputTokens": 8192,
        "url": codebuddy_chat_url(p),
        "supportsToolCall": p.capabilities.tools || caps.tools,
        "supportsImages": p.capabilities.vision || caps.vision,
        "supportsReasoning": codebuddy_supports_reasoning(p.default_model.trim()),
    })
}

fn workbuddy_model_id(p: &Provider) -> String {
    format!("byok-{}", sanitize_codebuddy_id(&p.id))
}

fn workbuddy_model_entry(p: &Provider, api_key: &str) -> Value {
    let model_id = workbuddy_model_id(p);
    let model_name = if p.default_model.trim().is_empty() {
        model_id.clone()
    } else {
        p.default_model.trim().to_string()
    };

    let caps = p
        .model_caps
        .get(p.default_model.trim())
        .cloned()
        .unwrap_or_default();

    serde_json::json!({
        "id": model_id,
        "name": model_name,
        "vendor": p.name.trim(),
        "apiKey": api_key,
        "maxInputTokens": 128000,
        "maxOutputTokens": 8192,
        "url": codebuddy_chat_url(p),
        "useCustomProtocol": true,
        "supportsToolCall": p.capabilities.tools || caps.tools,
        "supportsImages": p.capabilities.vision || caps.vision,
        "supportsReasoning": codebuddy_supports_reasoning(p.default_model.trim()),
    })
}

fn opencode_model_id(p: &Provider) -> String {
    let model = p.default_model.trim();
    if model.is_empty() {
        "model".to_string()
    } else {
        model.to_string()
    }
}

fn opencode_model_ids(p: &Provider) -> Vec<String> {
    let mut out = Vec::new();
    let default_model = opencode_model_id(p);
    out.push(default_model);
    for model in &p.models {
        let id = model.trim();
        if !id.is_empty() && !out.iter().any(|existing| existing == id) {
            out.push(id.to_string());
        }
    }
    out
}

fn opencode_provider_entry(p: &Provider) -> Value {
    let provider_name = if p.name.trim().is_empty() {
        "AnyBridge"
    } else {
        p.name.trim()
    };

    let mut models = Map::new();
    for model_id in opencode_model_ids(p) {
        let mut model_meta = Map::new();
        model_meta.insert("name".to_string(), Value::String(model_id.clone()));
        models.insert(model_id, Value::Object(model_meta));
    }

    serde_json::json!({
        "npm": "@ai-sdk/openai-compatible",
        "name": provider_name,
        "options": {
            "baseURL": openai_base_url(p),
            "apiKey": p.api_key,
        },
        "models": Value::Object(models),
    })
}

fn mask_opencode_entry_api_key(entry: &mut Value) {
    if let Some(options) = entry.get_mut("options").and_then(Value::as_object_mut) {
        if let Some(value) = options.get_mut("apiKey") {
            if let Some(masked) = value.as_str().map(mask_key) {
                *value = Value::String(masked);
            }
        }
    }
}

fn opencode_settings_from_config(config: &OpenCodeConfig, mask_token: bool) -> Value {
    if let Some(settings) = config.settings_config.as_ref() {
        let mut out = settings.clone();
        if mask_token {
            mask_opencode_entry_api_key(&mut out);
        }
        return out;
    }

    let provider = Provider::from(config.clone());
    let mut entry = opencode_provider_entry(&provider);
    if mask_token {
        mask_opencode_entry_api_key(&mut entry);
    }
    entry
}

fn opencode_preview_from_config(config: &OpenCodeConfig) -> Value {
    let mut provider_map = Map::new();
    provider_map.insert(
        config.id.clone(),
        opencode_settings_from_config(config, true),
    );

    serde_json::json!({
        "opencode.json": {
            "$schema": "https://opencode.ai/config.json",
            "provider": Value::Object(provider_map),
        },
    })
}

fn opencode_preview(p: &Provider) -> Value {
    let mut provider_map = Map::new();
    let mut entry = opencode_provider_entry(p);
    mask_opencode_entry_api_key(&mut entry);
    provider_map.insert(p.id.clone(), entry);

    serde_json::json!({
        "opencode.json": {
            "$schema": "https://opencode.ai/config.json",
            "provider": Value::Object(provider_map),
        },
    })
}

fn apply_opencode_config_file(path: &PathBuf, config: &OpenCodeConfig) -> Result<(), String> {
    let raw = if path.exists() {
        fs::read_to_string(path).map_err(|e| e.to_string())?
    } else {
        String::new()
    };
    let mut obj = parse_json_object(&raw, "opencode.json")?;

    obj.entry("$schema")
        .or_insert_with(|| Value::String("https://opencode.ai/config.json".to_string()));

    let provider_value = obj
        .entry("provider")
        .or_insert_with(|| Value::Object(Map::new()));
    let provider_obj = provider_value
        .as_object_mut()
        .ok_or_else(|| "opencode.json 的 provider 字段不是对象".to_string())?;

    let settings = opencode_settings_from_config(config, false);
    if !settings.is_object() {
        return Err("OpenCode provider 配置 JSON 顶层必须是对象".to_string());
    }
    provider_obj.insert(config.id.clone(), settings);

    let json = serde_json::to_string_pretty(&Value::Object(obj)).map_err(|e| e.to_string())?;
    super::write_atomic(path, json.as_bytes())
}

fn zcode_model_id(p: &Provider) -> String {
    let model = p.default_model.trim();
    if model.is_empty() {
        "model".to_string()
    } else {
        model.to_string()
    }
}

fn zcode_provider_entry(p: &Provider, api_key: &str) -> Value {
    let model_id = zcode_model_id(p);
    let provider_name = if p.name.trim().is_empty() {
        "AnyBridge"
    } else {
        p.name.trim()
    };
    let caps = p
        .model_caps
        .get(p.default_model.trim())
        .cloned()
        .unwrap_or_default();
    let supports_images = p.capabilities.vision || caps.vision;
    let input_modalities = if supports_images {
        serde_json::json!(["text", "image"])
    } else {
        serde_json::json!(["text"])
    };

    let mut model_meta = Map::new();
    model_meta.insert(
        "limit".to_string(),
        serde_json::json!({
            "context": 128000,
        }),
    );
    model_meta.insert(
        "modalities".to_string(),
        serde_json::json!({
            "input": input_modalities,
            "output": ["text"],
        }),
    );

    let mut models = Map::new();
    models.insert(model_id, Value::Object(model_meta));

    serde_json::json!({
        "name": provider_name,
        "kind": "openai-compatible",
        "options": {
            "apiKey": api_key,
            "baseURL": zcode_base_url_from_provider(p),
            "apiKeyRequired": true,
        },
        "source": "custom",
        "models": Value::Object(models),
    })
}

fn zcode_preview(p: &Provider, api_key: &str) -> Value {
    let mut provider_map = Map::new();
    provider_map.insert(
        ZCODE_PROVIDER_ID.to_string(),
        zcode_provider_entry(p, api_key),
    );

    serde_json::json!({
        "v2/config.json": {
            "provider": Value::Object(provider_map.clone()),
        },
        "cli/config.json": {
            "provider": Value::Object(provider_map),
        },
    })
}

fn apply_zcode_config_file(path: &PathBuf, p: &Provider) -> Result<(), String> {
    let raw = if path.exists() {
        fs::read_to_string(path).map_err(|e| e.to_string())?
    } else {
        String::new()
    };
    let mut obj = parse_json_object(&raw, "config.json")?;

    obj.entry("$schema")
        .or_insert_with(|| Value::String("https://zcode.z.ai/config.json".to_string()));

    let provider_value = obj
        .entry("provider")
        .or_insert_with(|| Value::Object(Map::new()));
    let provider_obj = provider_value
        .as_object_mut()
        .ok_or_else(|| "config.json 的 provider 字段不是对象".to_string())?;
    provider_obj.retain(|provider_id, provider| !zcode_is_managed_provider(provider_id, provider));
    provider_obj.insert(
        ZCODE_PROVIDER_ID.to_string(),
        zcode_provider_entry(p, &p.api_key),
    );

    let json = serde_json::to_string_pretty(&Value::Object(obj)).map_err(|e| e.to_string())?;
    super::write_atomic(path, json.as_bytes())
}

fn zcode_config_path() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or("无法定位用户主目录")?;
    Ok(home.join(".zcode").join("v2").join("config.json"))
}

fn zcode_cli_config_path() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or("无法定位用户主目录")?;
    Ok(home.join(".zcode").join("cli").join("config.json"))
}

fn zcode_model_item(provider_id: &str, provider: &Value, model_id: &str, model: &Value) -> Value {
    let provider_name = provider
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("Custom");
    let options = provider.get("options").and_then(Value::as_object);
    let base_url = options
        .and_then(|o| o.get("baseURL").or_else(|| o.get("baseUrl")))
        .and_then(Value::as_str)
        .unwrap_or_default();
    let api_key = options
        .and_then(|o| o.get("apiKey"))
        .and_then(Value::as_str)
        .unwrap_or_default();
    let display_name = model
        .get("name")
        .and_then(Value::as_str)
        .map(|s| s.to_string())
        .unwrap_or_else(|| format!("{provider_name} · {model_id}"));
    let input_modalities = model
        .get("modalities")
        .and_then(|m| m.get("input"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let supports_images = input_modalities.iter().any(|v| v.as_str() == Some("image"));
    let supports_reasoning = zcode_model_supports_reasoning(model);
    let max_input_tokens = model
        .get("limit")
        .and_then(|m| m.get("context"))
        .and_then(Value::as_u64);
    let max_output_tokens = model
        .get("limit")
        .and_then(|m| m.get("output"))
        .and_then(Value::as_u64);

    let mut item = serde_json::json!({
        "id": model_id,
        "name": display_name,
        "vendor": provider_name,
        "url": zcode_normalize_base_url(base_url),
        "apiKey": api_key,
        "providerId": provider_id,
        "supportsToolCall": false,
        "supportsImages": supports_images,
        "supportsReasoning": supports_reasoning,
    });
    if let Some(obj) = item.as_object_mut() {
        if let Some(value) = max_input_tokens {
            obj.insert("maxInputTokens".to_string(), serde_json::json!(value));
        }
        if let Some(value) = max_output_tokens {
            obj.insert("maxOutputTokens".to_string(), serde_json::json!(value));
        }
    }
    item
}

fn load_zcode_models() -> Result<serde_json::Value, String> {
    let path = zcode_config_path()?;
    let fallback = zcode_cli_config_path()?;
    let read_path = if path.exists() {
        path.clone()
    } else {
        fallback
    };
    if !read_path.exists() {
        return Ok(serde_json::json!({
            "models": [],
            "availableModels": [],
            "_configPath": path.to_string_lossy().to_string(),
            "_configScope": "user",
        }));
    }

    let raw = fs::read_to_string(&read_path).map_err(|e| format!("读取失败: {e}"))?;
    if raw.trim().is_empty() {
        return Ok(serde_json::json!({
            "models": [],
            "availableModels": [],
            "_configPath": read_path.to_string_lossy().to_string(),
            "_configScope": "user",
        }));
    }

    let value: Value = json5::from_str(&raw).map_err(|e| format!("解析失败: {e}"))?;
    let mut models = Vec::new();
    let mut available = Vec::new();
    if let Some(providers) = value.get("provider").and_then(Value::as_object) {
        for (provider_id, provider) in providers {
            let kind = provider
                .get("kind")
                .and_then(Value::as_str)
                .unwrap_or_default();
            if kind != "openai-compatible" {
                continue;
            }
            let source = provider
                .get("source")
                .and_then(Value::as_str)
                .unwrap_or_default();
            if source == "builtin" || provider_id.starts_with("builtin:") {
                continue;
            }
            if let Some(provider_models) = provider.get("models").and_then(Value::as_object) {
                for (model_id, model) in provider_models {
                    available.push(model_id.clone());
                    models.push(zcode_model_item(provider_id, provider, model_id, model));
                }
            }
        }
    }

    Ok(serde_json::json!({
        "models": models,
        "availableModels": available,
        "_configPath": read_path.to_string_lossy().to_string(),
        "_configScope": "user",
    }))
}

fn zcode_provider_id_from_model(model: &Value, _index: usize) -> String {
    if let Some(provider_id) = model.get("providerId").and_then(Value::as_str) {
        if !zcode_provider_id_needs_migration(provider_id, model) {
            return provider_id.to_string();
        }
    }
    // 按 vendor + baseURL 分组：同一供应商的所有模型归入同一个 provider。
    // providerId 不能拼接 apiKey，避免把密钥泄漏进配置键名。
    let vendor = model
        .get("vendor")
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty())
        .unwrap_or("custom");
    let url = model.get("url").and_then(Value::as_str).unwrap_or_default();
    let base_url = zcode_normalize_base_url(url);
    let composite = format!("{vendor}|{base_url}");
    format!("AnyBridge-{}", short_hash(&composite))
}

fn zcode_model_meta_from_model(model: &Value) -> (String, Value) {
    let model_id = model
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or("model")
        .to_string();
    let display_name = model
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or(&model_id);
    let supports_images = model
        .get("supportsImages")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let supports_reasoning = model
        .get("supportsReasoning")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let input = if supports_images {
        serde_json::json!(["text", "image"])
    } else {
        serde_json::json!(["text"])
    };
    let max_input = model
        .get("maxInputTokens")
        .and_then(Value::as_u64)
        .unwrap_or(128000);
    let mut meta = serde_json::json!({
        "name": display_name,
        "limit": { "context": max_input },
        "modalities": {
            "input": input,
            "output": ["text"],
        },
    });
    if let Some(max_output) = model.get("maxOutputTokens").and_then(Value::as_u64) {
        if let Some(limit) = meta.get_mut("limit").and_then(Value::as_object_mut) {
            limit.insert("output".to_string(), serde_json::json!(max_output));
        }
    }
    if supports_reasoning {
        if let Some(obj) = meta.as_object_mut() {
            obj.insert(
                "reasoning".to_string(),
                serde_json::json!({
                    "enabled": true,
                    "variants": ["enabled", "off"],
                    "defaultVariant": "enabled",
                }),
            );
        }
    }
    (model_id, meta)
}

fn write_zcode_models_to_path(path: &PathBuf, models: &[Value]) -> Result<(), String> {
    ensure_parent_dir(path)?;
    ensure_backup(path)?;
    let raw = if path.exists() {
        fs::read_to_string(path).map_err(|e| e.to_string())?
    } else {
        String::new()
    };
    let mut obj = parse_json_object(&raw, "config.json")?;
    obj.entry("$schema")
        .or_insert_with(|| Value::String("https://zcode.z.ai/config.json".to_string()));

    let mut provider_obj = obj
        .remove("provider")
        .and_then(|v| v.as_object().cloned())
        .unwrap_or_default();

    provider_obj.retain(|provider_id, provider| {
        let source = provider
            .get("source")
            .and_then(Value::as_str)
            .unwrap_or_default();
        (source == "builtin" || provider_id.starts_with("builtin:"))
            && !zcode_is_managed_provider(provider_id, provider)
    });

    let mut groups: BTreeMap<String, (String, String, String, Map<String, Value>)> =
        BTreeMap::new();
    for (index, model) in models.iter().enumerate() {
        let model_id = model.get("id").and_then(Value::as_str).unwrap_or_default();
        if model_id.trim().is_empty() {
            continue;
        }
        let provider_id = zcode_provider_id_from_model(model, index);
        let vendor = model
            .get("vendor")
            .and_then(Value::as_str)
            .unwrap_or("Custom")
            .to_string();
        let url = model
            .get("url")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let base_url = zcode_normalize_base_url(&url);
        let api_key = model
            .get("apiKey")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let (model_id, meta) = zcode_model_meta_from_model(model);
        groups
            .entry(provider_id)
            .or_insert_with(|| (vendor, base_url, api_key, Map::new()))
            .3
            .insert(model_id, meta);
    }

    for (provider_id, (vendor, url, api_key, model_map)) in groups {
        provider_obj.insert(
            provider_id,
            serde_json::json!({
                "name": vendor,
                "kind": "openai-compatible",
                "options": {
                    "apiKey": api_key,
                    "baseURL": url,
                    "apiKeyRequired": true,
                },
                "source": "custom",
                "models": Value::Object(model_map),
            }),
        );
    }

    obj.insert("provider".to_string(), Value::Object(provider_obj));
    let json = serde_json::to_string_pretty(&Value::Object(obj)).map_err(|e| e.to_string())?;
    super::write_atomic(path, json.as_bytes()).map_err(|e| format!("写入失败: {e}"))
}

fn codebuddy_supports_reasoning(model: &str) -> bool {
    let m = model.to_ascii_lowercase();
    m.contains("reason")
        || m.contains("thinking")
        || m.contains("deepseek-r1")
        || m == "r1"
        || m.starts_with("o1")
        || m.starts_with("o3")
        || m.starts_with("o4")
}

fn split_url_origin_path(input: &str) -> Option<(String, String, String)> {
    let url = reqwest::Url::parse(input).ok()?;
    let host = url.host_str()?.to_ascii_lowercase();
    let mut origin = format!("{}://{}", url.scheme(), url.host_str()?);
    if let Some(port) = url.port() {
        origin.push_str(&format!(":{port}"));
    }
    let path = url.path().trim_end_matches('/').to_string();
    Some((origin, host, path))
}

fn is_official_dashscope_hostname(host: &str) -> bool {
    matches!(
        host,
        "dashscope.aliyuncs.com" | "dashscope-intl.aliyuncs.com" | "dashscope-us.aliyuncs.com"
    )
}

fn codebuddy_chat_url(p: &Provider) -> String {
    let endpoint = provider_endpoint_url(p);
    if let Some((origin, host, path)) = split_url_origin_path(&endpoint) {
        if is_official_dashscope_hostname(&host) {
            let lower = path.to_ascii_lowercase();
            let chat_path = if lower.ends_with("/compatible-mode/v1/chat/completions") {
                path
            } else if lower.ends_with("/compatible-mode/v1/responses") {
                strip_first_matching_suffix(&path, &["/responses"]) + "/chat/completions"
            } else if lower.ends_with("/compatible-mode/v1") {
                format!("{path}/chat/completions")
            } else if lower.ends_with("/compatible-mode") {
                format!("{path}/v1/chat/completions")
            } else {
                "/compatible-mode/v1/chat/completions".to_string()
            };
            return format!("{origin}{chat_path}");
        }
    }

    let base = strip_first_matching_suffix(&endpoint, &["/chat/completions", "/responses"]);
    if base.to_ascii_lowercase().ends_with("/v1") {
        format!("{base}/chat/completions")
    } else {
        format!("{base}/v1/chat/completions")
    }
}

fn openai_base_url(p: &Provider) -> String {
    strip_first_matching_suffix(&codebuddy_chat_url(p), &["/chat/completions"])
}

fn zcode_normalize_base_url(value: &str) -> String {
    strip_first_matching_suffix(
        value.trim().trim_end_matches('/'),
        &["/chat/completions", "/responses"],
    )
    .trim_end_matches('/')
    .to_string()
}

fn zcode_base_url_from_provider(p: &Provider) -> String {
    zcode_normalize_base_url(&openai_base_url(p))
}

fn zcode_model_supports_reasoning(model: &Value) -> bool {
    match model.get("reasoning") {
        Some(Value::Bool(value)) => *value,
        Some(Value::Object(obj)) => obj.get("enabled").and_then(Value::as_bool).unwrap_or(true),
        _ => false,
    }
}

fn short_hash(value: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(value.as_bytes());
    let digest = hex::encode(hasher.finalize());
    digest[..12].to_string()
}

fn zcode_provider_id_needs_migration(provider_id: &str, model: &Value) -> bool {
    let provider_id = provider_id.trim();
    if provider_id.is_empty() {
        return true;
    }
    let api_key = model
        .get("apiKey")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim();
    if !api_key.is_empty() && provider_id.contains(api_key) {
        return true;
    }
    provider_id == ZCODE_PROVIDER_ID
        || provider_id.contains("://")
        || provider_id.contains('/')
        || provider_id.contains('\\')
}

fn zcode_is_managed_provider(provider_id: &str, provider: &Value) -> bool {
    if provider_id.starts_with("builtin:") {
        return false;
    }
    let source = provider
        .get("source")
        .and_then(Value::as_str)
        .unwrap_or_default();
    source == "anybridge"
        || source == "ide-byok"
        || provider_id == ZCODE_PROVIDER_ID
        || provider_id.starts_with("AnyBridge-")
        || provider_id.starts_with("anybridge")
        || provider_id.starts_with("ide-byok")
}

/// token 脱敏：保留前 6 后 4，中间用 *** 代替。
fn mask_key(k: &str) -> String {
    let k = k.trim();
    if k.len() <= 12 {
        return "***".into();
    }
    format!("{}***{}", &k[..6], &k[k.len() - 4..])
}

/// TOML 字符串值转义（用于预览片段里的 name）。
fn toml_escape(s: &str) -> String {
    s.replace('\\', "\\\\").replace('"', "\\\"")
}

// ═══════ TAURI COMMANDS ═══════

/// 检测所有支持的平台：安装状态 + 当前接管的供应商 + 备份是否存在。
#[tauri::command]
pub fn detect_platforms() -> Result<Vec<PlatformInfo>, String> {
    let store = read_provider_store().unwrap_or_default();
    let platforms = [
        Platform::ClaudeCode,
        Platform::Codex,
        Platform::CodeBuddy,
        Platform::OpenCode,
        Platform::WorkBuddy,
        Platform::ZCode,
    ];
    let mut out = Vec::with_capacity(platforms.len());

    for plat in platforms {
        let config_path_buf = plat.config_path();
        let config_path = config_path_buf
            .as_ref()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_default();
        let backup_exists = plat.backup_exists();

        let state = store.platforms.get(plat.id());
        let mut current_provider_id = state.map(|s| s.provider_id.clone());
        let mut applied_at = state.map(|s| s.applied_at.clone());
        let mut current_provider_name = current_provider_id.as_ref().and_then(|pid| {
            if matches!(plat, Platform::ClaudeCode) {
                store
                    .claude_code_configs
                    .iter()
                    .find(|config| &config.id == pid)
                    .map(|config| config.name.clone())
            } else if matches!(plat, Platform::Codex) {
                store
                    .codex_configs
                    .iter()
                    .find(|config| &config.id == pid)
                    .map(|config| config.name.clone())
            } else if matches!(plat, Platform::OpenCode) {
                store
                    .opencode_configs
                    .iter()
                    .find(|config| &config.id == pid)
                    .map(|config| config.name.clone())
            } else {
                store
                    .providers
                    .iter()
                    .find(|p| &p.id == pid)
                    .map(|p| p.name.clone())
            }
        });
        let mut managed_by_any_bridge = state.is_some();
        let mut claude_config = None;
        let mut codex_config = None;
        let mut live_provider_ids = Vec::new();
        let mut error = None;

        if matches!(plat, Platform::ClaudeCode) {
            if let Some(path) = config_path_buf.as_ref() {
                match read_claude_config_info(path) {
                    Ok(Some(mut info)) => {
                        if info.is_official {
                            current_provider_id = Some("anthropic-official".to_string());
                            current_provider_name = Some("Anthropic 官方".to_string());
                            managed_by_any_bridge = false;
                            applied_at = None;
                        } else {
                            let matched_config = store.claude_code_configs.iter().find(|config| {
                                let provider = Provider::from((*config).clone());
                                claude_provider_matches_config(&info, &provider)
                            });
                            let state_matches = state
                                .and_then(|s| {
                                    store.claude_code_configs.iter().find(|config| {
                                        if config.id != s.provider_id {
                                            return false;
                                        }
                                        let provider = Provider::from((*config).clone());
                                        claude_provider_matches_config(&info, &provider)
                                    })
                                })
                                .is_some();

                            if state_matches {
                                managed_by_any_bridge = true;
                                current_provider_id = state.map(|s| s.provider_id.clone());
                                current_provider_name =
                                    current_provider_id.as_ref().and_then(|pid| {
                                        store
                                            .claude_code_configs
                                            .iter()
                                            .find(|config| &config.id == pid)
                                            .map(|config| config.name.clone())
                                    });
                            } else {
                                managed_by_any_bridge = false;
                                applied_at = None;
                                current_provider_id = matched_config
                                    .map(|config| config.id.clone())
                                    .or_else(|| info.base_url.clone());
                                current_provider_name = matched_config
                                    .map(|config| config.name.clone())
                                    .or_else(|| Some("外部配置".to_string()));
                            }
                        }
                        info.managed_by_any_bridge = managed_by_any_bridge;
                        claude_config = Some(info);
                    }
                    Ok(None) => {
                        managed_by_any_bridge = false;
                        applied_at = None;
                        current_provider_id = Some("anthropic-official".to_string());
                        current_provider_name = Some("Anthropic 官方".to_string());
                    }
                    Err(e) => {
                        error = Some(e);
                    }
                }
            }
        } else if matches!(plat, Platform::Codex) {
            if let Some(path) = config_path_buf.as_ref() {
                match read_codex_config_info(path) {
                    Ok(info) => {
                        if let Some(info) = info {
                            if info.is_official {
                                current_provider_id = Some("openai-official".to_string());
                                current_provider_name = Some("OpenAI 官方".to_string());
                            } else {
                                current_provider_id = if info.managed_by_any_bridge {
                                    state
                                        .map(|s| s.provider_id.clone())
                                        .or_else(|| info.model_provider_id.clone())
                                } else {
                                    info.model_provider_id.clone()
                                };
                                current_provider_name = info.provider_name.clone().or_else(|| {
                                    current_provider_id.as_ref().and_then(|pid| {
                                        store
                                            .codex_configs
                                            .iter()
                                            .find(|config| &config.id == pid)
                                            .map(|config| config.name.clone())
                                    })
                                });
                            }
                            managed_by_any_bridge = info.managed_by_any_bridge;
                            if !managed_by_any_bridge {
                                applied_at = None;
                            }
                            codex_config = Some(info);
                        }
                    }
                    Err(e) => {
                        error = Some(e);
                    }
                }
            }
        } else if matches!(plat, Platform::OpenCode) {
            if let Some(path) = config_path_buf.as_ref() {
                match read_opencode_live_provider_ids(path) {
                    Ok(ids) => {
                        live_provider_ids = ids;
                        let active_provider_id =
                            read_opencode_active_model_provider_id(path).ok().flatten();
                        current_provider_id = active_provider_id.or_else(|| {
                            if live_provider_ids.len() == 1 {
                                live_provider_ids.first().cloned()
                            } else {
                                None
                            }
                        });
                        managed_by_any_bridge = live_provider_ids
                            .iter()
                            .any(|id| store.opencode_configs.iter().any(|config| &config.id == id));
                        applied_at = None;
                        current_provider_name = current_provider_id.as_ref().and_then(|pid| {
                            store
                                .opencode_configs
                                .iter()
                                .find(|config| &config.id == pid)
                                .map(|config| config.name.clone())
                                .or_else(|| Some(pid.clone()))
                        });
                        if current_provider_name.is_none() && !live_provider_ids.is_empty() {
                            current_provider_name =
                                Some(format!("已加入 {} 个配置", live_provider_ids.len()));
                        }
                    }
                    Err(e) => {
                        managed_by_any_bridge = false;
                        applied_at = None;
                        error = Some(e);
                    }
                }
            }
        }

        out.push(PlatformInfo {
            id: plat.id().to_string(),
            display_name: plat.display_name().to_string(),
            vendor: plat.vendor().to_string(),
            required_api_format: plat.required_api_format().to_string(),
            installed: plat.detect_installed(),
            config_path,
            backup_exists,
            current_provider_id,
            current_provider_name,
            managed_by_any_bridge,
            applied_at,
            live_provider_ids,
            codex_config,
            claude_config,
            error,
        });
    }
    Ok(out)
}

/// 预览将写入目标平台的配置片段（token 脱敏），供 UI 做 diff 展示。
#[tauri::command]
pub fn preview_platform_switch(platform: String, provider_id: String) -> Result<String, String> {
    let plat = Platform::from_id(&platform).ok_or_else(|| format!("未知平台: {platform}"))?;
    let store = read_provider_store()?;
    if matches!(plat, Platform::ClaudeCode) {
        let config = store
            .claude_code_configs
            .iter()
            .find(|config| config.id == provider_id)
            .ok_or_else(|| format!("Claude Code 配置不存在: {provider_id}"))?;
        return serde_json::to_string_pretty(&claude_settings_from_config(config, true))
            .map_err(|e| e.to_string());
    }
    if matches!(plat, Platform::OpenCode) {
        let config = store
            .opencode_configs
            .iter()
            .find(|config| config.id == provider_id)
            .ok_or_else(|| format!("OpenCode 配置不存在: {provider_id}"))?;
        return serde_json::to_string_pretty(&opencode_preview_from_config(config))
            .map_err(|e| e.to_string());
    }
    let provider = resolve_platform_config(&plat, &store, &provider_id)?;
    plat.preview(&provider)
}

/// 切换平台供应商：备份 + 写入配置文件，并记录到 providerStore.platforms。
#[tauri::command]
pub fn switch_platform(platform: String, provider_id: String) -> Result<SwitchResult, String> {
    let plat = Platform::from_id(&platform).ok_or_else(|| format!("未知平台: {platform}"))?;
    let mut store = read_provider_store()?;

    if matches!(plat, Platform::ClaudeCode) {
        let config = store
            .claude_code_configs
            .iter()
            .find(|config| config.id == provider_id)
            .cloned()
            .ok_or_else(|| format!("Claude Code 配置不存在: {provider_id}"))?;
        let path = plat
            .config_path()
            .ok_or_else(|| "无法定位用户主目录".to_string())?;
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("创建配置目录失败: {e}"))?;
        }
        ensure_backup(&path)?;
        apply_claude_config_file(&path, &config)?;

        let config_path = path.to_string_lossy().to_string();
        let backup = backup_path(&path).to_string_lossy().to_string();
        store.platforms.insert(
            plat.id().to_string(),
            PlatformState {
                provider_id: config.id.clone(),
                applied_at: now_epoch_secs(),
            },
        );
        write_provider_store(&store)?;

        return Ok(SwitchResult {
            ok: true,
            message: format!(
                "已将 Claude Code 切换到「{}」，重启 Claude Code 后生效",
                config.name
            ),
            config_path,
            backup_path: backup,
        });
    }

    if matches!(plat, Platform::OpenCode) {
        let config = store
            .opencode_configs
            .iter()
            .find(|config| config.id == provider_id)
            .cloned()
            .ok_or_else(|| format!("OpenCode 配置不存在: {provider_id}"))?;
        let path = plat
            .config_path()
            .ok_or_else(|| "无法定位用户主目录".to_string())?;
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("创建配置目录失败: {e}"))?;
        }
        ensure_backup(&path)?;
        apply_opencode_config_file(&path, &config)?;

        let config_path = path.to_string_lossy().to_string();
        let backup = backup_path(&path).to_string_lossy().to_string();

        return Ok(SwitchResult {
            ok: true,
            message: format!(
                "已将 OpenCode 配置「{}」加入 live provider 列表，新会话或重启 OpenCode 后可使用",
                config.name
            ),
            config_path,
            backup_path: backup,
        });
    }

    let provider = resolve_platform_config(&plat, &store, &provider_id)?;

    let path = plat.apply(&provider)?;
    let config_path = path.to_string_lossy().to_string();
    let backup = backup_path(&path).to_string_lossy().to_string();

    if !matches!(plat, Platform::OpenCode) {
        store.platforms.insert(
            plat.id().to_string(),
            PlatformState {
                provider_id: provider.id.clone(),
                applied_at: now_epoch_secs(),
            },
        );
        write_provider_store(&store)?;
    }

    let mut message = if matches!(plat, Platform::OpenCode) {
        format!(
            "已将 OpenCode 配置「{}」加入 live provider 列表，新会话或重启 OpenCode 后可使用",
            provider.name
        )
    } else {
        format!(
            "已将 {} 切换到「{}」，重启 {} 后生效",
            plat.display_name(),
            provider.name,
            plat.display_name()
        )
    };
    if matches!(plat, Platform::Codex) {
        message.push_str(&repair_codex_session_visibility_message(&path));
    }

    Ok(SwitchResult {
        ok: true,
        message,
        config_path,
        backup_path: backup,
    })
}

/// 从 OpenCode live 配置移除一个 provider entry；不删除 AnyBridge 保存的 OpenCode 配置方案。
#[tauri::command]
pub fn remove_opencode_config_from_live(provider_id: String) -> Result<SwitchResult, String> {
    let plat = Platform::OpenCode;
    let path = plat
        .config_path()
        .ok_or_else(|| "无法定位用户主目录".to_string())?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建配置目录失败: {e}"))?;
    }
    if path.exists() {
        ensure_backup(&path)?;
    }

    let raw = if path.exists() {
        fs::read_to_string(&path).map_err(|e| e.to_string())?
    } else {
        String::new()
    };
    let mut obj = parse_json_object(&raw, "opencode.json")?;
    if let Some(providers) = obj.get_mut("provider").and_then(Value::as_object_mut) {
        providers.remove(&provider_id);
    }

    let json = serde_json::to_string_pretty(&Value::Object(obj)).map_err(|e| e.to_string())?;
    super::write_atomic(&path, json.as_bytes())?;

    let config_path = path.to_string_lossy().to_string();
    let backup = backup_path(&path).to_string_lossy().to_string();
    Ok(SwitchResult {
        ok: true,
        message: format!("已从 OpenCode live 配置移除「{}」", provider_id),
        config_path,
        backup_path: backup,
    })
}

/// 从备份还原平台配置（回到 AnyBridge 接管前的状态），并清除接管记录。
#[tauri::command]
pub fn restore_platform(platform: String) -> Result<bool, String> {
    let plat = Platform::from_id(&platform).ok_or_else(|| format!("未知平台: {platform}"))?;
    let restored = plat.restore()?;

    // 无论是否有备份，都清除接管记录（接管状态以备份为准）。
    if let Ok(mut store) = read_provider_store() {
        if store.platforms.remove(plat.id()).is_some() {
            let _ = write_provider_store(&store);
        }
    }
    Ok(restored)
}

/// 切回 Claude Code 官方环境：清理 AnyBridge 写入的 ANTHROPIC_* env 字段，保留其他设置。
#[tauri::command]
pub fn restore_claude_official_config() -> Result<SwitchResult, String> {
    let plat = Platform::ClaudeCode;
    let path = plat
        .config_path()
        .ok_or_else(|| "无法定位用户主目录".to_string())?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建配置目录失败: {e}"))?;
    }
    if path.exists() {
        ensure_backup(&path)?;
    }
    plat.apply_claude_official(&path)?;

    if let Ok(mut store) = read_provider_store() {
        if store.platforms.remove(plat.id()).is_some() {
            let _ = write_provider_store(&store);
        }
    }

    let config_path = path.to_string_lossy().to_string();
    let backup = backup_path(&path).to_string_lossy().to_string();
    Ok(SwitchResult {
        ok: true,
        message: "已切回 Claude Code 官方配置，重启 Claude Code 后生效".to_string(),
        config_path,
        backup_path: backup,
    })
}

/// 切回 Codex 官方 OpenAI 配置：不依赖 .byok-bak，不修改 auth.json。
#[tauri::command]
pub fn restore_codex_official_config() -> Result<SwitchResult, String> {
    let plat = Platform::Codex;
    let path = plat
        .config_path()
        .ok_or_else(|| "无法定位用户主目录".to_string())?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建配置目录失败: {e}"))?;
    }
    ensure_backup(&path)?;
    plat.apply_codex_official(&path)?;

    if let Ok(mut store) = read_provider_store() {
        if store.platforms.remove(plat.id()).is_some() {
            let _ = write_provider_store(&store);
        }
    }

    let config_path = path.to_string_lossy().to_string();
    let backup = backup_path(&path).to_string_lossy().to_string();
    let mut message = "已切回 Codex 官方 OpenAI 配置，重启 Codex 后生效".to_string();
    message.push_str(&repair_codex_session_visibility_message(&path));
    Ok(SwitchResult {
        ok: true,
        message,
        config_path,
        backup_path: backup,
    })
}

/// 手动修复 Codex 历史会话可见性：对齐当前 config.toml 的 model_provider 与本地会话索引。
#[tauri::command]
pub fn repair_codex_session_visibility(
) -> Result<super::codex_session_visibility::CodexSessionVisibilityRepairSummary, String> {
    let path = Platform::Codex
        .config_path()
        .ok_or_else(|| "无法定位用户主目录".to_string())?;
    super::codex_session_visibility::repair_default_codex_session_visibility(&path)
}

// ─── CodeBuddy 自定义模型管理命令 ────────────────────────────

#[derive(Serialize)]
pub struct ProviderModelItem {
    pub id: String,
    pub name: String,
    #[serde(rename = "supportsToolCall")]
    pub supports_tool_call: bool,
    #[serde(rename = "supportsImages")]
    pub supports_images: bool,
    #[serde(rename = "supportsReasoning")]
    pub supports_reasoning: bool,
}

#[derive(Serialize)]
pub struct ProviderModelsEntry {
    #[serde(rename = "providerId")]
    pub provider_id: String,
    #[serde(rename = "providerName")]
    pub provider_name: String,
    pub models: Vec<ProviderModelItem>,
    #[serde(rename = "apiHost")]
    pub api_host: String,
    #[serde(rename = "apiKey")]
    pub api_key: String,
    #[serde(rename = "apiPath")]
    pub api_path: Option<String>,
    #[serde(rename = "chatUrl")]
    pub chat_url: String,
    #[serde(rename = "apiFormat")]
    pub api_format: String,
}

fn codebuddy_config_path(platform: &str) -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or("无法定位用户主目录")?;
    let dir = match platform {
        PLATFORM_CODEBUDDY => home.join(".codebuddy"),
        PLATFORM_WORKBUDDY => home.join(".workbuddy"),
        _ => return Err(format!("未知 CodeBuddy 平台: {platform}")),
    };
    Ok(dir.join("models.json"))
}

fn codebuddy_project_config_path(platform: &str) -> Result<PathBuf, String> {
    let cwd = std::env::current_dir().map_err(|e| format!("无法定位当前工作目录: {e}"))?;
    let dir_name = match platform {
        PLATFORM_CODEBUDDY => ".codebuddy",
        PLATFORM_WORKBUDDY => ".workbuddy",
        _ => return Err(format!("未知 CodeBuddy 平台: {platform}")),
    };
    Ok(cwd.join(dir_name).join("models.json"))
}

fn codebuddy_config_path_for_scope(platform: &str, scope: Option<&str>) -> Result<PathBuf, String> {
    match scope.unwrap_or("user") {
        "project" => codebuddy_project_config_path(platform),
        "user" | "" => codebuddy_config_path(platform),
        other => Err(format!("未知配置作用域: {other}")),
    }
}

fn codebuddy_load_candidate(platform: &str) -> Result<(PathBuf, &'static str), String> {
    let user_path = codebuddy_config_path(platform)?;
    if user_path.exists() {
        let raw = fs::read_to_string(&user_path).map_err(|e| format!("读取失败: {e}"))?;
        if !raw.trim().is_empty() {
            return Ok((user_path, "user"));
        }
    }

    let project_path = codebuddy_project_config_path(platform)?;
    if project_path.exists() {
        let raw = fs::read_to_string(&project_path).map_err(|e| format!("读取失败: {e}"))?;
        if !raw.trim().is_empty() {
            return Ok((project_path, "project"));
        }
    }

    Ok((user_path, "user"))
}

fn attach_codebuddy_config_meta(
    value: serde_json::Value,
    path: &PathBuf,
    scope: &str,
) -> serde_json::Value {
    match value {
        serde_json::Value::Object(mut obj) => {
            obj.insert(
                "_configPath".to_string(),
                serde_json::Value::String(path.to_string_lossy().to_string()),
            );
            obj.insert(
                "_configScope".to_string(),
                serde_json::Value::String(scope.to_string()),
            );
            serde_json::Value::Object(obj)
        }
        other => other,
    }
}

/// 读取 CodeBuddy models.json 的完整内容。
#[tauri::command]
pub fn load_codebuddy_models(platform: String) -> Result<serde_json::Value, String> {
    if platform == PLATFORM_ZCODE {
        return load_zcode_models();
    }

    let (path, scope) = codebuddy_load_candidate(&platform)?;
    if !path.exists() {
        return Ok(serde_json::json!({
            "models": [],
            "availableModels": [],
            "_configPath": path.to_string_lossy().to_string(),
            "_configScope": scope,
        }));
    }
    let raw = fs::read_to_string(&path).map_err(|e| format!("读取失败: {e}"))?;
    if raw.trim().is_empty() {
        return Ok(serde_json::json!({
            "models": [],
            "availableModels": [],
            "_configPath": path.to_string_lossy().to_string(),
            "_configScope": scope,
        }));
    }
    let value: serde_json::Value = json5::from_str(&raw).map_err(|e| format!("解析失败: {e}"))?;
    Ok(attach_codebuddy_config_meta(value, &path, scope))
}

/// 保存 CodeBuddy models.json（原子写 + 自动备份）。
#[tauri::command]
pub fn save_codebuddy_models(
    platform: String,
    models: Vec<serde_json::Value>,
    available_models: Vec<String>,
    scope: Option<String>,
) -> Result<String, String> {
    if platform == PLATFORM_ZCODE {
        let path = zcode_config_path()?;
        write_zcode_models_to_path(&path, &models)?;
        let cli_path = zcode_cli_config_path()?;
        write_zcode_models_to_path(&cli_path, &models)?;
        return Ok(path.to_string_lossy().to_string());
    }

    let path = codebuddy_config_path_for_scope(&platform, scope.as_deref())?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建目录失败: {e}"))?;
    }
    ensure_backup(&path)?;

    let payload = serde_json::json!({
        "models": models,
        "availableModels": available_models,
    });
    let json = serde_json::to_string_pretty(&payload).map_err(|e| format!("序列化失败: {e}"))?;
    super::write_atomic(&path, json.as_bytes()).map_err(|e| format!("写入失败: {e}"))?;
    Ok(path.to_string_lossy().to_string())
}

/// 返回所有供应商及其真实模型列表，供平台和本地代理的「从供应商添加」使用。
#[tauri::command]
pub fn list_provider_models() -> Result<Vec<ProviderModelsEntry>, String> {
    let store = read_provider_store()?;
    let mut out = Vec::new();
    for p in &store.providers {
        if p.enabled == false {
            continue;
        }
        let model_ids = p.models.clone();
        let models: Vec<ProviderModelItem> = model_ids
            .iter()
            .map(|m| {
                let caps = p.model_caps.get(m).cloned().unwrap_or_default();
                ProviderModelItem {
                    id: m.clone(),
                    name: m.clone(),
                    supports_tool_call: p.capabilities.tools || caps.tools,
                    supports_images: p.capabilities.vision || caps.vision,
                    supports_reasoning: codebuddy_supports_reasoning(m),
                }
            })
            .collect();
        out.push(ProviderModelsEntry {
            provider_id: p.id.clone(),
            provider_name: p.name.clone(),
            models,
            api_host: p.api_host.clone(),
            api_key: p.api_key.clone(),
            api_path: p.api_path.clone(),
            chat_url: codebuddy_chat_url(p),
            api_format: "openai".to_string(),
        });
    }
    Ok(out)
}

fn repair_codex_session_visibility_message(path: &Path) -> String {
    match super::codex_session_visibility::repair_default_codex_session_visibility(path) {
        Ok(summary) => format!("。{}", summary.message),
        Err(error) => format!(
            "。但同步 Codex 历史会话可见性失败：{}。配置已写入，可关闭 Codex 后重试切换",
            error
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::config::ProviderCapabilities;
    use std::collections::HashMap;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_config_path(name: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("anybridge-{name}-{nanos}"));
        fs::create_dir_all(&dir).unwrap();
        dir.join("config.toml")
    }

    fn test_openai_provider() -> Provider {
        Provider {
            id: "provider-1".to_string(),
            name: "Test Provider".to_string(),
            api_host: "https://example.com".to_string(),
            api_key: "sk-test-secret".to_string(),
            api_path: Some("/v1/responses".to_string()),
            default_model: "gpt-test".to_string(),
            api_format: ApiFormat::Openai,
            enabled: true,
            models: Vec::new(),
            capabilities: ProviderCapabilities {
                text: true,
                stream: true,
                vision: false,
                tools: false,
                gzip: false,
            },
            model_caps: HashMap::new(),
        }
    }

    #[test]
    fn apply_codex_preserves_unrelated_toml_sections() {
        let path = temp_config_path("codex-preserve");
        fs::write(
            &path,
            r#"
model = "old-model"
model_provider = "old"

[mcp_servers.docs]
command = "node"

[projects."E:/project/demo"]
trust_level = "trusted"

[model_providers.old]
base_url = "https://old.example.com/v1"
wire_api = "responses"
"#,
        )
        .unwrap();

        let provider = test_openai_provider();
        Platform::Codex.apply_codex(&path, &provider).unwrap();

        let raw = fs::read_to_string(&path).unwrap();
        let doc = raw.parse::<DocumentMut>().unwrap();
        assert_eq!(doc["model"].as_str(), Some("gpt-test"));
        assert_eq!(doc["model_provider"].as_str(), Some("byok"));
        assert_eq!(
            doc["model_providers"]["byok"]["base_url"].as_str(),
            Some("https://example.com/v1")
        );
        assert_eq!(
            doc["model_providers"]["byok"]["experimental_bearer_token"].as_str(),
            Some("sk-test-secret")
        );
        assert_eq!(
            doc["model_providers"]["old"]["base_url"].as_str(),
            Some("https://old.example.com/v1")
        );
        assert_eq!(doc["mcp_servers"]["docs"]["command"].as_str(), Some("node"));
        assert_eq!(
            doc["projects"]["E:/project/demo"]["trust_level"].as_str(),
            Some("trusted")
        );

        let _ = fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn read_codex_config_info_uses_only_active_provider() {
        let path = temp_config_path("codex-active");
        fs::write(
            &path,
            r#"
model = "gpt-5.5"
model_provider = "codex_local_access"

[model_providers.byok]
name = "AnyBridge stale"
base_url = "https://stale.example.com/v1"
wire_api = "responses"
experimental_bearer_token = "sk-stale"

[model_providers.codex_local_access]
name = "AnyRouter"
base_url = "https://anyrouter.top/v1"
wire_api = "responses"
"#,
        )
        .unwrap();

        let info = read_codex_config_info(&path).unwrap().unwrap();
        assert_eq!(info.model.as_deref(), Some("gpt-5.5"));
        assert_eq!(
            info.model_provider_id.as_deref(),
            Some("codex_local_access")
        );
        assert_eq!(info.provider_name.as_deref(), Some("AnyRouter"));
        assert_eq!(info.base_url.as_deref(), Some("https://anyrouter.top/v1"));
        assert_eq!(info.wire_api.as_deref(), Some("responses"));
        assert!(!info.has_bearer_token);
        assert!(!info.managed_by_any_bridge);

        let _ = fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn read_codex_config_info_marks_byok_as_managed() {
        let path = temp_config_path("codex-byok");
        fs::write(
            &path,
            r#"
model = "gpt-test"
model_provider = "byok"

[model_providers.byok]
name = "Test Provider"
base_url = "https://example.com/v1"
wire_api = "responses"
experimental_bearer_token = "sk-test-secret"
"#,
        )
        .unwrap();

        let info = read_codex_config_info(&path).unwrap().unwrap();
        assert_eq!(info.model_provider_id.as_deref(), Some("byok"));
        assert_eq!(info.provider_name.as_deref(), Some("Test Provider"));
        assert!(info.has_bearer_token);
        assert!(!info.is_official);
        assert!(info.managed_by_any_bridge);

        let _ = fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn read_codex_config_info_without_provider_is_official() {
        let path = temp_config_path("codex-official");
        fs::write(
            &path,
            r#"
[mcp_servers.docs]
command = "node"
"#,
        )
        .unwrap();

        let info = read_codex_config_info(&path).unwrap().unwrap();
        assert!(info.is_official);
        assert!(!info.managed_by_any_bridge);
        assert_eq!(info.model_provider_id, None);

        let _ = fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn apply_codex_official_removes_active_byok_but_preserves_common_config() {
        let path = temp_config_path("codex-restore-official");
        fs::write(
            &path,
            r#"
model = "third-party-model"
model_provider = "byok"

[mcp_servers.docs]
command = "node"

[model_providers.byok]
name = "AnyBridge"
base_url = "https://example.com/v1"
wire_api = "responses"
experimental_bearer_token = "sk-test"

[model_providers.codex_local_access]
name = "AnyRouter"
base_url = "https://anyrouter.top/v1"
wire_api = "responses"
"#,
        )
        .unwrap();

        Platform::Codex.apply_codex_official(&path).unwrap();

        let raw = fs::read_to_string(&path).unwrap();
        let doc = raw.parse::<DocumentMut>().unwrap();
        assert!(doc.get("model").is_none());
        assert!(doc.get("model_provider").is_none());
        assert!(doc["model_providers"]
            .as_table()
            .unwrap()
            .get("byok")
            .is_none());
        assert_eq!(
            doc["model_providers"]["codex_local_access"]["base_url"].as_str(),
            Some("https://anyrouter.top/v1")
        );
        assert_eq!(doc["mcp_servers"]["docs"]["command"].as_str(), Some("node"));

        let _ = fs::remove_dir_all(path.parent().unwrap());
    }
}
