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
use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};
use toml_edit::{value, Array, DocumentMut, Item, Table};

use super::config::{
    read_provider_store, write_provider_store, AgentsGlobalConfig, ClaudeCodeConfig,
    ModelCatalogEntry, OpenCodeConfig, PlatformState, Provider, ProviderStore,
};

const PLATFORM_CLAUDE_CODE: &str = "claude-code";
const PLATFORM_CODEX: &str = "codex";
const PLATFORM_CODEBUDDY: &str = "codebuddy";
const PLATFORM_OPENCODE: &str = "opencode";
const PLATFORM_WORKBUDDY: &str = "workbuddy";
const PLATFORM_ZCODE: &str = "zcode";
const CLAUDE_MODEL_ENV_KEYS: &[&str] = &[
    "ANTHROPIC_MODEL",
    "ANTHROPIC_REASONING_MODEL",
    "ANTHROPIC_SMALL_FAST_MODEL",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME",
    "ANTHROPIC_DEFAULT_SONNET_MODEL",
    "ANTHROPIC_DEFAULT_SONNET_MODEL_NAME",
    "ANTHROPIC_DEFAULT_OPUS_MODEL",
    "ANTHROPIC_DEFAULT_OPUS_MODEL_NAME",
    "ANTHROPIC_DEFAULT_FABLE_MODEL",
    "ANTHROPIC_DEFAULT_FABLE_MODEL_NAME",
];
const CLAUDE_AUTH_ENV_KEYS: &[&str] = &[
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_API_KEY",
    "OPENROUTER_API_KEY",
    "GOOGLE_API_KEY",
];
const CLAUDE_MANAGED_ENV_KEYS: &[&str] = &[
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_API_KEY",
    "OPENROUTER_API_KEY",
    "GOOGLE_API_KEY",
    "ANTHROPIC_MODEL",
    "ANTHROPIC_REASONING_MODEL",
    "ANTHROPIC_SMALL_FAST_MODEL",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME",
    "ANTHROPIC_DEFAULT_SONNET_MODEL",
    "ANTHROPIC_DEFAULT_SONNET_MODEL_NAME",
    "ANTHROPIC_DEFAULT_OPUS_MODEL",
    "ANTHROPIC_DEFAULT_OPUS_MODEL_NAME",
    "ANTHROPIC_DEFAULT_FABLE_MODEL",
    "ANTHROPIC_DEFAULT_FABLE_MODEL_NAME",
];
const ABSENT_BACKUP_SENTINEL: &[u8] = b"__IDE_BYOK_ORIGINAL_FILE_ABSENT__\n";
const ZCODE_PROVIDER_ID: &str = "AnyBridge";

// ─── 切换进度事件 ──────────────────────────────────────────────

#[derive(Clone, Serialize)]
struct SwitchProgressPayload {
    platform: String,
    step: String,
    message: String,
}

pub(crate) fn emit_switch_progress(app: &AppHandle, platform: &str, step: &str, message: &str) {
    let _ = app.emit(
        "platform-switch-progress",
        SwitchProgressPayload {
            platform: platform.to_string(),
            step: step.to_string(),
            message: message.to_string(),
        },
    );
}

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
    #[serde(skip)]
    pub model_candidates: Vec<String>,
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
        match self {
            Platform::Codex => codex_home(),
            Platform::ClaudeCode
            | Platform::CodeBuddy
            | Platform::OpenCode
            | Platform::WorkBuddy
            | Platform::ZCode => {
                let home = dirs::home_dir()?;
                Some(match self {
                    Platform::ClaudeCode => home.join(".claude"),
                    Platform::CodeBuddy => home.join(".codebuddy"),
                    Platform::OpenCode => home.join(".config").join("opencode"),
                    Platform::WorkBuddy => home.join(".workbuddy"),
                    Platform::ZCode => home.join(".zcode"),
                    Platform::Codex => unreachable!(),
                })
            }
        }
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
                let base = if p.route_through_proxy {
                    codex_base_url()
                } else {
                    let host = p.api_host.trim().trim_end_matches('/');
                    let path = p
                        .api_path
                        .as_deref()
                        .unwrap_or("/v1")
                        .trim()
                        .trim_start_matches('/');
                    format!("{}/{}", host, path)
                };
                let model = toml_escape(p.default_model.trim());
                let bearer_for_preview = if p.route_through_proxy {
                    codex_bearer_token().unwrap_or_default()
                } else {
                    p.api_key.clone()
                };
                let masked = mask_key(&bearer_for_preview);
                let name = toml_escape(&p.name);
                // wire_api 始终为 "responses"：Codex 始终用 Responses API 与本地代理通信，
                // 由代理根据 provider 的 wireApi 配置决定是否转换为 Chat Completions。
                let catalog_line = if !resolve_codex_model_catalog_entries(p).is_empty() {
                    format!("\nmodel_catalog_json = \"{CODEX_MODEL_CATALOG_FILENAME}\"")
                } else {
                    String::new()
                };
                let auth_line = if p.preserve_official_auth {
                    "requires_openai_auth = true".to_string()
                } else {
                    format!("requires_openai_auth = false\nexperimental_bearer_token = \"{masked}\"")
                };
                Ok(format!(
                    "model = \"{model}\"\nmodel_provider = \"{CODEX_RUNTIME_MODEL_PROVIDER_ID}\"{catalog_line}\n\n[model_providers.{CODEX_RUNTIME_MODEL_PROVIDER_ID}]\nname = \"{name}\"\nbase_url = \"{base}\"\nwire_api = \"responses\"\n{auth_line}\n{CODEX_ANYBRIDGE_MANAGED_FLAG} = true"
                ))
            }
            Platform::CodeBuddy => {
                let preview_model = codebuddy_model_entry(p, &mask_key(&p.api_key));
                // 不写 availableModels：客户端会把该字段当白名单整表替换，导致官方模型消失。
                let preview = serde_json::json!({
                    "models": [preview_model],
                });
                serde_json::to_string_pretty(&preview).map_err(|e| e.to_string())
            }
            Platform::OpenCode => {
                let preview = opencode_preview(p);
                serde_json::to_string_pretty(&preview).map_err(|e| e.to_string())
            }
            Platform::WorkBuddy => {
                let preview_model = workbuddy_model_entry(p, &mask_key(&p.api_key));
                // 不写 availableModels：客户端会把该字段当白名单整表替换，导致官方模型消失。
                let preview = serde_json::json!({
                    "models": [preview_model],
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
        set_claude_model_env(env_obj, &model);

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
            for key in CLAUDE_MANAGED_ENV_KEYS {
                env.remove(*key);
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

        let base = if p.route_through_proxy {
            codex_base_url()
        } else {
            // 直连供应商：拼接 apiHost + apiPath（不写 localhost 代理地址）
            let host = p.api_host.trim().trim_end_matches('/');
            let path = p
                .api_path
                .as_deref()
                .unwrap_or("/v1")
                .trim()
                .trim_start_matches('/');
            format!("{}/{}", host, path)
        };
        let bearer = if p.route_through_proxy {
            codex_bearer_token()?
        } else {
            let key = p.api_key.trim();
            if key.is_empty() {
                return Err("Codex 直连供应商缺少 API Key".to_string());
            }
            key.to_string()
        };
        let model = p.default_model.trim();

        if !model.is_empty() {
            doc["model"] = value(model);
        }
        doc["model_provider"] = value(CODEX_RUNTIME_MODEL_PROVIDER_ID);

        // service_tier 是 OpenAI 官方专属字段（Pro/Fast 等计费层级），
        // 第三方 API 不支持此参数，残留会导致 Codex 请求被拒、无法对话。
        doc.as_table_mut().remove("service_tier");

        // 确保 [model_providers] 是表，再写入统一的 Codex local access 子表。
        let providers = doc
            .entry("model_providers")
            .or_insert(Item::Table(Table::new()))
            .as_table_mut()
            .ok_or_else(|| "config.toml 的 model_providers 不是表".to_string())?;
        // 让 [model_providers] 表头在已有子表时不重复输出。
        providers.set_implicit(true);
        // 清理 AnyBridge 旧版 provider id，避免 byok/codex_local_access 并存导致历史过滤混乱。
        providers.remove(CODEX_LEGACY_MODEL_PROVIDER_ID);

        let provider_table = providers
            .entry(CODEX_RUNTIME_MODEL_PROVIDER_ID)
            .or_insert(Item::Table(Table::new()))
            .as_table_mut()
            .ok_or_else(|| {
                format!("config.toml 的 model_providers.{CODEX_RUNTIME_MODEL_PROVIDER_ID} 不是表")
            })?;
        provider_table["name"] = value(p.name.clone());
        provider_table["base_url"] = value(base);
        // wire_api 始终为 "responses"：Codex 始终用 Responses API 与本地代理通信，
        // 由代理根据 provider 的 wireApi 配置决定是否转换为 Chat Completions。
        provider_table["wire_api"] = value("responses");
        // Auth 互斥（官方文档 / openai/codex#16288）：
        // - OpenAI OAuth：requires_openai_auth=true，禁止 experimental_bearer_token / env_key / .auth
        // - 第三方静态凭证：requires_openai_auth=false + experimental_bearer_token（或 env_key）
        // 残留冲突会导致 Codex 读 auth.json.refresh_token，apikey 模式下 refresh_token 为空。
        apply_codex_provider_auth(provider_table, p.preserve_official_auth, Some(bearer.as_str()));
        provider_table[CODEX_ANYBRIDGE_MANAGED_FLAG] = value(true);

        // ── 模型目录：让 Codex 显示自定义模型列表 ──
        // catalog 目录必须与 config.toml 同目录；禁止回退到进程 CWD。
        let catalog_dir = path.parent().ok_or_else(|| {
            format!("无法定位 Codex 配置目录（config 路径异常）: {}", path.display())
        })?;
        let catalog_entries = resolve_codex_model_catalog_entries(p);
        if !catalog_entries.is_empty() {
            let catalog_json = generate_model_catalog_json(&catalog_entries)?;
            let catalog_path = catalog_dir.join(CODEX_MODEL_CATALOG_FILENAME);
            super::write_atomic(&catalog_path, catalog_json.as_bytes())?;
            doc["model_catalog_json"] = value(CODEX_MODEL_CATALOG_FILENAME);
        } else {
            doc.as_table_mut().remove("model_catalog_json");
            let _ = fs::remove_file(catalog_dir.join(CODEX_MODEL_CATALOG_FILENAME));
        }

        let agents_finalize = apply_codex_agents(path, &mut doc, p)?;

        super::write_atomic(path, doc.to_string().as_bytes())?;
        finalize_codex_agents_files(path, agents_finalize)
    }

    fn apply_codex_official(&self, path: &PathBuf, unify_session_history: bool) -> Result<(), String> {
        let raw = if path.exists() {
            fs::read_to_string(path).map_err(|e| e.to_string())?
        } else {
            String::new()
        };
        let mut doc = raw
            .parse::<DocumentMut>()
            .map_err(|e| format!("config.toml 解析失败: {e}"))?;

        if unify_session_history {
            // 统一会话历史模式：保留 model_provider = codex_local_access，
            // 配置 provider 使用官方 OAuth 认证（requires_openai_auth=true），
            // 不设 base_url（Codex 回落到官方端点），不写 bearer_token。
            // 这样官方会话和第三方会话都在 codex_local_access 桶中。
            doc["model_provider"] = value(CODEX_RUNTIME_MODEL_PROVIDER_ID);
            // 移除第三方模型指针（让 Codex 使用官方默认模型）
            doc.as_table_mut().remove("model");
            doc.as_table_mut().remove("model_catalog_json");

            if let Some(catalog_dir) = path.parent() {
                let _ = fs::remove_file(catalog_dir.join(CODEX_MODEL_CATALOG_FILENAME));
            }

            let providers = doc
                .entry("model_providers")
                .or_insert(Item::Table(Table::new()))
                .as_table_mut()
                .ok_or_else(|| "config.toml 的 model_providers 不是表".to_string())?;
            providers.set_implicit(true);
            providers.remove(CODEX_LEGACY_MODEL_PROVIDER_ID);

            let provider_table = providers
                .entry(CODEX_RUNTIME_MODEL_PROVIDER_ID)
                .or_insert(Item::Table(Table::new()))
                .as_table_mut()
                .ok_or_else(|| {
                    format!("config.toml 的 model_providers.{CODEX_RUNTIME_MODEL_PROVIDER_ID} 不是表")
                })?;
            provider_table["name"] = value("OpenAI 官方");
            provider_table["wire_api"] = value("responses");
            provider_table.remove("base_url");
            apply_codex_provider_auth(provider_table, true, None);
            provider_table[CODEX_ANYBRIDGE_MANAGED_FLAG] = value(true);
        } else {
            // 原有行为：OpenAI Official uses Codex's built-in provider and auth.json login.
            // Keep common settings, but remove the active third-party pointer.
            doc.as_table_mut().remove("model");
            doc.as_table_mut().remove("model_provider");
            doc.as_table_mut().remove("model_catalog_json");

            // 删除可能存在的模型目录文件
            if let Some(catalog_dir) = path.parent() {
                let _ = fs::remove_file(catalog_dir.join(CODEX_MODEL_CATALOG_FILENAME));
            }

            let providers_empty = doc["model_providers"]
                .as_table_mut()
                .map(|providers| {
                    providers.remove(CODEX_LEGACY_MODEL_PROVIDER_ID);
                    let should_remove_runtime = providers
                        .get(CODEX_RUNTIME_MODEL_PROVIDER_ID)
                        .and_then(Item::as_table)
                        .map(|table| toml_table_bool(table, CODEX_ANYBRIDGE_MANAGED_FLAG))
                        .unwrap_or(false);
                    if should_remove_runtime {
                        providers.remove(CODEX_RUNTIME_MODEL_PROVIDER_ID);
                    }
                    providers.is_empty()
                })
                .unwrap_or(false);
            if providers_empty {
                doc.as_table_mut().remove("model_providers");
            }
        }

        let agents_finalize =
            CodexAgentsFinalize::cleanup_only(cleanup_anybridge_codex_agents(path, &mut doc)?);

        super::write_atomic(path, doc.to_string().as_bytes())?;
        finalize_codex_agents_files(path, agents_finalize)
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

    // CodeBuddy / WorkBuddy 的 availableModels 是最终模型白名单。
    // SmartMerge 对字符串数组是整表替换；若只写自定义 id，官方模型会被 AvailableModelsFilter 滤掉。
    // 因此 AnyBridge 只维护 models，让客户端用内置列表 + 自定义 models 合并。
    obj.remove("availableModels");

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

/// Codex config.toml 里的 base_url：永远指向本地 anybridge 的 Codex 专用代理入口（不写上游 URL）。
///
/// 关键设计决策：Codex 客户端只与 anybridge 代理通信，**绝不直连 provider 上游**。
/// 原因：
///   1. 真实 provider 上游 URL + apiKey 存到 `codex-proxy-routes.json`（由 7450 代理查表），
///      避免上游 key 暴露给 Codex 客户端。
///   2. 代理负责 Chat↔Responses 格式转换、retry、token 统计、错误归一。
///   3. 任何 supplier 走代理，统一可观测（统计、debug）。
///
/// provider 的 `apiHost` 不再用作 Codex 直连 URL——它只用作"由 7450 代理 + codex-proxy-routes.json 转发"的上游目标。
fn codex_base_url() -> String {
    use crate::commands::config::configured_proxy_ports;
    let port = configured_proxy_ports().api_port;
    format!("http://127.0.0.1:{port}/codex/v1")
}

/// Codex config.toml 里的 bearer_token：代理模式写 anybridge 本地代理 key。
///
/// 代理收到请求后用 `validateAuth` 验证该 token（与 byok-config.json 的 LOCAL_PROXY_KEY 比对），
/// 通过后由 7450 代理查 codex-proxy-routes.json 找到真实 provider + 上游 apiKey 转发。
fn codex_bearer_token() -> Result<String, String> {
    crate::commands::config::read_config_value("LOCAL_PROXY_KEY")
        .filter(|s| !s.is_empty())
        .ok_or_else(|| {
            "byok-config.json 的 LOCAL_PROXY_KEY 尚未生成。\n\
             请启动 AnyBridge 触发一次代理页（首次启动会自动生成 LOCAL_PROXY_KEY），然后重试。"
                .to_string()
        })
}

/// 写入 Codex provider 认证字段并清除互斥残留。
///
/// 官方文档 (learn.chatgpt.com config-advanced) 与 openai/codex#16288：
/// `[model_providers.<id>.auth]` / `env_key` / `experimental_bearer_token` / `requires_openai_auth`
/// 不得混用。第三方静态凭证路径：`requires_openai_auth=false` + bearer。
fn apply_codex_provider_auth(
    provider_table: &mut Table,
    preserve_official_auth: bool,
    bearer: Option<&str>,
) {
    // 无论哪条路径，都先清掉可能残留的互斥/动态 auth 字段，避免历史手工编辑冲突。
    provider_table.remove("env_key");
    provider_table.remove("env_key_instructions");
    provider_table.remove("auth");

    if preserve_official_auth {
        provider_table["requires_openai_auth"] = value(true);
        provider_table.remove("experimental_bearer_token");
    } else {
        provider_table["requires_openai_auth"] = value(false);
        match bearer {
            Some(token) if !token.trim().is_empty() => {
                provider_table["experimental_bearer_token"] = value(token);
            }
            _ => {
                // 无 bearer 时也必须去掉旧 token，避免 OAuth/apikey 语义漂移。
                provider_table.remove("experimental_bearer_token");
            }
        }
    }
}

/// 模型目录文件名
pub(crate) const CODEX_MODEL_CATALOG_FILENAME: &str = "anybridge-model-catalog.json";
const CODEX_ANYBRIDGE_AGENTS_DIRNAME: &str = "anybridge-agents";
const CODEX_ANYBRIDGE_AGENTS_MANIFEST: &str = "manifest.json";
const CODEX_ANYBRIDGE_MANAGED_FLAG: &str = "anybridge_managed";

/// 解析 Codex 配置目录：优先 `CODEX_HOME`，否则 `~/.codex`。
/// 与官方 Codex CLI 行为一致，避免用户自定义 CODEX_HOME 时写到错误路径。
pub(crate) fn codex_home() -> Option<PathBuf> {
    if let Ok(raw) = std::env::var("CODEX_HOME") {
        let trimmed = raw.trim();
        if !trimmed.is_empty() {
            return Some(PathBuf::from(trimmed));
        }
    }
    dirs::home_dir().map(|h| h.join(".codex"))
}

/// 从 Provider 合成 model_catalog：优先用显式 model_catalog；
/// 为空时回退 models / default_model，避免只配了模型列表却不写 catalog。
pub(crate) fn resolve_codex_model_catalog_entries(p: &Provider) -> Vec<ModelCatalogEntry> {
    if !p.model_catalog.is_empty() {
        return p.model_catalog.clone();
    }
    let mut seen = HashSet::new();
    let mut entries = Vec::new();
    let mut push = |model: &str| {
        let m = model.trim();
        if m.is_empty() || !seen.insert(m.to_string()) {
            return;
        }
        entries.push(ModelCatalogEntry {
            model: m.to_string(),
            display_name: None,
            context_window: None,
        });
    };
    for m in &p.models {
        push(m);
    }
    push(&p.default_model);
    entries
}
const CODEX_LEGACY_ANYBRIDGE_SLUG_PREFIX: &str = "anybridge:";
const CODEX_RUNTIME_MODEL_PROVIDER_ID: &str = "codex_local_access";
const CODEX_LEGACY_MODEL_PROVIDER_ID: &str = "byok";
const CODEX_PROXY_ROUTE_SOURCE_PREFIX: &str = "codex:";

// ─── Bundled Codex 客户端模型目录（从 cockpit-tools v1.1.4 移植） ──────────
//
// 新版 Codex 客户端（含 GPT-5.6 系列）使用 bundled catalog 提供完整模型定义，
// 不依赖运行时读取 ~/.codex/models_cache.json。旧版客户端仍走 models_cache 逻辑。
const CODEX_BUNDLED_CATALOG_JSON: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/resources/codex/codex_client_models.json"
));
const CODEX_BUNDLED_CATALOG_TEMPLATE_SLUG: &str = "gpt-5.5";

fn codex_bundled_catalog() -> &'static Value {
    static CATALOG: std::sync::OnceLock<Value> = std::sync::OnceLock::new();
    CATALOG.get_or_init(|| {
        serde_json::from_str(CODEX_BUNDLED_CATALOG_JSON)
            .expect("Bundled codex_client_models.json should be valid")
    })
}

/// 从 bundled catalog 提取 model_overrides 中的所有模型 slug（新版模型列表）。
fn codex_bundled_model_ids() -> &'static HashSet<String> {
    static IDS: std::sync::OnceLock<HashSet<String>> = std::sync::OnceLock::new();
    IDS.get_or_init(|| {
        codex_bundled_catalog()
            .get("model_overrides")
            .and_then(Value::as_array)
            .map(|models| {
                models
                    .iter()
                    .filter_map(|m| m.get("slug").and_then(Value::as_str))
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(ToString::to_string)
                    .collect()
            })
            .unwrap_or_default()
    })
}

/// 判断一个模型 slug 是否在 bundled catalog 的 model_overrides 中（即"新版"模型）。
pub(crate) fn is_codex_bundled_model(slug: &str) -> bool {
    codex_bundled_model_ids()
        .iter()
        .any(|id| id.eq_ignore_ascii_case(slug))
}

/// 从 bundled catalog 查找模型模板。
///
/// 1. 先在 `models` 数组中精确匹配 slug（如 gpt-5.5, gpt-5.4 等已有完整定义的模型）
/// 2. 若未找到，用 gpt-5.5 作为基础模板，再从 `model_overrides` 中查找并合并覆盖字段
///    （如 gpt-5.6-sol, gpt-5.6-terra, gpt-5.6-luna 等新模型）
/// 3. 若 model_overrides 中也没有，返回 gpt-5.5 模板（is_catalog_model = false）
///
/// 返回 (模型 JSON, 是否为 catalog 中已存在的完整模型定义)。
pub(crate) fn codex_bundled_model_template(model_id: &str) -> (Value, bool) {
    let payload = codex_bundled_catalog();
    let models = payload
        .get("models")
        .and_then(Value::as_array)
        .expect("Bundled catalog should include models array");

    // 1. 精确匹配
    if let Some(model) = models.iter().find(|m| {
        m.get("slug")
            .and_then(Value::as_str)
            .is_some_and(|slug| slug.eq_ignore_ascii_case(model_id))
    }) {
        return (model.clone(), true);
    }

    // 2. 用 gpt-5.5 做基础模板，合并 model_overrides
    let default_model = models
        .iter()
        .find(|m| {
            m.get("slug").and_then(Value::as_str) == Some(CODEX_BUNDLED_CATALOG_TEMPLATE_SLUG)
        })
        .cloned()
        .expect("Bundled catalog should include gpt-5.5 template");

    if let Some(model_override) = payload
        .get("model_overrides")
        .and_then(Value::as_array)
        .and_then(|overrides| {
            overrides.iter().find(|m| {
                m.get("slug")
                    .and_then(Value::as_str)
                    .is_some_and(|slug| slug.eq_ignore_ascii_case(model_id))
            })
        })
    {
        let mut model = default_model;
        if let (Some(target), Some(override_obj)) =
            (model.as_object_mut(), model_override.as_object())
        {
            for (key, value) in override_obj {
                target.insert(key.clone(), value.clone());
            }
        }
        return (model, true);
    }

    // 3. 未知模型，返回 gpt-5.5 模板
    (default_model, false)
}

/// 读取 `~/.codex/models_cache.json` 的第一个模型条目作为 deep-clone 模板。
///
/// Codex CLI 对模型目录做严格 schema 校验（30+ 字段：base_instructions、
/// model_messages、supports_reasoning_summaries、comp_hash、input_modalities…），
/// 任何缺字段都会导致 `codex exec` 启动时报 "missing field `xxx`"。
///
/// 治本方案：直接复用官方 gpt-5.5 条目作为模板，避免手写 schema 错漏。
/// models_cache.json 由 Codex 首次运行时自动生成，读取它不需要启动 Codex。
pub(crate) fn read_codex_model_template() -> Option<serde_json::Value> {
    let path = codex_home()?.join("models_cache.json");
    let raw = std::fs::read_to_string(&path).ok()?;
    let parsed: serde_json::Value = serde_json::from_str(&raw).ok()?;
    let models = parsed.get("models")?.as_array()?;
    let catalog_slugs = read_codex_catalog_slugs_for_template();
    models
        .iter()
        .find(|m| is_codex_official_template_candidate(m, &catalog_slugs, true, true))
        .or_else(|| {
            models
                .iter()
                .find(|m| is_codex_official_template_candidate(m, &catalog_slugs, true, false))
        })
        .or_else(|| {
            models
                .iter()
                .find(|m| is_codex_official_template_candidate(m, &catalog_slugs, false, true))
        })
        .or_else(|| {
            models
                .iter()
                .find(|m| is_codex_official_template_candidate(m, &catalog_slugs, false, false))
        })
        .cloned()
}

fn read_codex_catalog_slugs_for_template() -> HashSet<String> {
    let Some(dir) = codex_home() else {
        return HashSet::new();
    };
    let path = dir.join(CODEX_MODEL_CATALOG_FILENAME);
    let Ok(raw) = std::fs::read_to_string(path) else {
        return HashSet::new();
    };
    let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&raw) else {
        return HashSet::new();
    };
    let arr = if parsed.is_array() {
        parsed.as_array()
    } else {
        parsed.get("models").and_then(|m| m.as_array())
    };
    arr.map(|items| {
        items
            .iter()
            .filter_map(|m| {
                m.get("slug")
                    .and_then(Value::as_str)
                    .or_else(|| m.get("model").and_then(Value::as_str))
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(ToString::to_string)
            })
            .collect()
    })
    .unwrap_or_default()
}

fn is_codex_official_template_candidate(
    model: &serde_json::Value,
    catalog_slugs: &HashSet<String>,
    prefer_openai_slug: bool,
    skip_catalog_slug: bool,
) -> bool {
    if model
        .get(CODEX_ANYBRIDGE_MANAGED_FLAG)
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        return false;
    }
    let slug = model
        .get("slug")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    if slug.is_empty() || slug.starts_with(CODEX_LEGACY_ANYBRIDGE_SLUG_PREFIX) {
        return false;
    }
    if skip_catalog_slug && catalog_slugs.contains(slug) {
        return false;
    }
    !prefer_openai_slug || slug.starts_with("gpt-")
}

/// 生成 Codex 模型目录 JSON 内容。
///
/// **新版逻辑（cockpit-tools v1.1.4 移植）**：如果模型 slug 在 bundled catalog 的
/// `model_overrides` 中（如 gpt-5.6-sol/terra/luna），直接使用 bundled catalog 的完整
/// 模型定义（含 supported_reasoning_levels、service_tiers、multi_agent_version 等），
/// 不依赖运行时 `~/.codex/models_cache.json`。
///
/// **旧版逻辑（保持兼容）**：如果模型 slug 不在 bundled catalog 中（用户自定义模型或
/// 旧版 Codex 模型），从 `~/.codex/models_cache.json` 读取官方 gpt-5.5 完整条目作为模板，
/// deep-clone 后只覆盖 6 个字段：slug, display_name, description, context_window,
/// max_context_window, priority。其余 26+ 字段从官方模板继承。
///
/// 返回 Err 让上层（apply_codex → UI）显示明确错误：
/// 失败时**不静默退化**（debug-first 原则）。
pub(crate) fn generate_model_catalog_json(entries: &[ModelCatalogEntry]) -> Result<String, String> {
    // 旧版模板：仅在存在非 bundled 模型时才需要读取 models_cache.json
    let has_legacy_models = entries.iter().any(|e| !is_codex_bundled_model(&e.model));
    let legacy_template: Option<serde_json::Value> = if has_legacy_models {
        Some(read_codex_model_template().ok_or_else(|| {
            let path = codex_home()
                .map(|d| d.join("models_cache.json"))
                .map(|p| p.display().to_string())
                .unwrap_or_else(|| "CODEX_HOME/models_cache.json".to_string());
            format!(
                "无法读取 Codex 官方模型缓存 models_cache.json。\n\
                 请先启动一次 Codex CLI 让其生成此文件，然后重新切换供应商。\n\
                 路径: {path}"
            )
        })?)
    } else {
        None
    };

    let models: Vec<serde_json::Value> = entries
        .iter()
        .enumerate()
        .map(|(i, e)| {
            if is_codex_bundled_model(&e.model) {
                // ── 新版逻辑：使用 bundled catalog 完整定义 ──
                let (mut model, _) = codex_bundled_model_template(&e.model);
                let obj = model
                    .as_object_mut()
                    .expect("Bundled model template should be a JSON object");

                obj["priority"] = serde_json::json!(1000 + i);

                if let Some(dn) = &e.display_name {
                    if !dn.is_empty() {
                        obj["display_name"] = serde_json::json!(dn);
                    }
                }
                if let Some(ctx) = e.context_window {
                    obj["context_window"] = serde_json::json!(ctx);
                    obj["max_context_window"] = serde_json::json!(ctx);
                }

                obj.insert("supported_in_api".to_string(), Value::Bool(true));
                if !obj.contains_key("visibility") {
                    obj.insert("visibility".to_string(), Value::String("list".to_string()));
                }

                model
            } else {
                // ── 旧版逻辑：从 models_cache.json 模板 deep-clone ──
                let mut obj = legacy_template
                    .clone()
                    .expect("legacy_template verified above for non-bundled models");
                let display_name = e.display_name.as_deref().unwrap_or(e.model.as_str());
                let ctx = e.context_window.unwrap_or_else(|| {
                    recommend_context_window(&e.model)
                });
                obj["slug"] = serde_json::json!(e.model);
                obj["display_name"] = serde_json::json!(display_name);
                obj["description"] = serde_json::json!(display_name);
                obj["context_window"] = serde_json::json!(ctx);
                obj["max_context_window"] = serde_json::json!(ctx);
                obj["priority"] = serde_json::json!(1000 + i);
                obj
            }
        })
        .collect();

    let catalog = serde_json::json!({ "models": models });
    serde_json::to_string_pretty(&catalog).map_err(|e| format!("catalog 序列化失败: {e}"))
}

#[derive(Debug, Serialize, serde::Deserialize, Default)]
struct CodexAgentsManifest {
    version: u32,
    #[serde(default)]
    roles: Vec<String>,
    #[serde(default)]
    files: Vec<String>,
    #[serde(rename = "managedGlobal", default)]
    managed_global: BTreeMap<String, u64>,
}

struct PreparedCodexAgent {
    name: String,
    filename: String,
    role_description: String,
    nickname_candidates: Vec<String>,
    toml: String,
}

#[derive(Default)]
struct CodexAgentsFinalize {
    files_to_remove: Vec<String>,
    keep_files: HashSet<String>,
    manifest_json: Option<String>,
}

impl CodexAgentsFinalize {
    fn cleanup_only(files_to_remove: Vec<String>) -> Self {
        Self {
            files_to_remove,
            keep_files: HashSet::new(),
            manifest_json: None,
        }
    }
}

fn codex_agents_dir(config_path: &Path) -> PathBuf {
    let base = config_path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .map(|p| p.to_path_buf())
        .or_else(codex_home)
        .unwrap_or_else(|| PathBuf::from("."));
    base.join(CODEX_ANYBRIDGE_AGENTS_DIRNAME)
}

fn codex_agents_manifest_path(config_path: &Path) -> PathBuf {
    codex_agents_dir(config_path).join(CODEX_ANYBRIDGE_AGENTS_MANIFEST)
}

fn is_valid_codex_agent_name(name: &str) -> bool {
    let bytes = name.as_bytes();
    if bytes.is_empty() || bytes.len() > 64 {
        return false;
    }
    if !bytes[0].is_ascii_lowercase() {
        return false;
    }
    bytes
        .iter()
        .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'-')
}

fn is_reserved_codex_agent_name(name: &str) -> bool {
    matches!(name, "default" | "worker" | "explorer")
}

fn is_valid_codex_nickname(value: &str) -> bool {
    !value.trim().is_empty()
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b' ' || b == b'-' || b == b'_')
}

fn codex_agent_model_set(provider: &Provider) -> HashSet<String> {
    let mut models = HashSet::new();
    if !provider.default_model.trim().is_empty() {
        models.insert(provider.default_model.trim().to_string());
    }
    for model in &provider.models {
        if !model.trim().is_empty() {
            models.insert(model.trim().to_string());
        }
    }
    for entry in &provider.model_catalog {
        if !entry.model.trim().is_empty() {
            models.insert(entry.model.trim().to_string());
        }
    }
    models
}

fn toml_string_array(values: &[String]) -> Item {
    let mut arr = Array::default();
    for value in values {
        arr.push(value.as_str());
    }
    value(arr)
}

fn prepare_codex_agents(provider: &Provider) -> Result<Vec<PreparedCodexAgent>, String> {
    let models = codex_agent_model_set(provider);
    let mut seen = HashSet::new();
    let mut prepared = Vec::new();

    for agent in &provider.agents {
        let name = agent.name.trim();
        if !is_valid_codex_agent_name(name) {
            return Err(format!(
                "Codex 子代理名称「{}」无效：必须匹配 ^[a-z][a-z0-9-]{{0,63}}$",
                agent.name
            ));
        }
        if is_reserved_codex_agent_name(name) {
            return Err(format!(
                "Codex 子代理名称「{}」是内置名称，AnyBridge 当前版本不允许覆盖。",
                name
            ));
        }
        if !seen.insert(name.to_ascii_lowercase()) {
            return Err(format!("Codex 子代理名称重复: {name}"));
        }

        let description = agent.description.trim();
        if description.is_empty() {
            return Err(format!("Codex 子代理「{name}」缺少 description"));
        }
        let developer_instructions = agent.developer_instructions.trim();
        if developer_instructions.is_empty() {
            return Err(format!("Codex 子代理「{name}」缺少 developerInstructions"));
        }

        let model = agent.model.trim();
        if !model.is_empty() && !models.contains(model) {
            return Err(format!(
                "Codex 子代理「{name}」引用的模型「{model}」不在当前配置模型列表中"
            ));
        }

        if let Some(effort) = agent
            .model_reasoning_effort
            .as_deref()
            .map(str::trim)
            .filter(|v| !v.is_empty())
        {
            if !matches!(effort, "low" | "medium" | "high") {
                return Err(format!(
                    "Codex 子代理「{name}」的 modelReasoningEffort 无效: {effort}"
                ));
            }
        }

        if let Some(sandbox) = agent
            .sandbox_mode
            .as_deref()
            .map(str::trim)
            .filter(|v| !v.is_empty())
        {
            if !matches!(
                sandbox,
                "read-only" | "workspace-write" | "danger-full-access"
            ) {
                return Err(format!(
                    "Codex 子代理「{name}」的 sandboxMode 无效: {sandbox}"
                ));
            }
        }

        let mut nickname_seen = HashSet::new();
        let mut nicknames = Vec::new();
        for raw in &agent.nickname_candidates {
            let nickname = raw.trim();
            if nickname.is_empty() {
                continue;
            }
            if !is_valid_codex_nickname(nickname) {
                return Err(format!(
                    "Codex 子代理「{name}」的昵称「{nickname}」无效：仅允许 ASCII 字母、数字、空格、连字符和下划线"
                ));
            }
            if !nickname_seen.insert(nickname.to_ascii_lowercase()) {
                return Err(format!("Codex 子代理「{name}」的昵称重复: {nickname}"));
            }
            nicknames.push(nickname.to_string());
        }

        let mut agent_doc = DocumentMut::new();
        agent_doc["name"] = value(name);
        agent_doc["description"] = value(description);
        agent_doc["developer_instructions"] = value(developer_instructions);
        if !model.is_empty() {
            agent_doc["model"] = value(model);
        }
        if let Some(effort) = agent
            .model_reasoning_effort
            .as_deref()
            .map(str::trim)
            .filter(|v| !v.is_empty())
        {
            agent_doc["model_reasoning_effort"] = value(effort);
        }
        if let Some(sandbox) = agent
            .sandbox_mode
            .as_deref()
            .map(str::trim)
            .filter(|v| !v.is_empty())
        {
            agent_doc["sandbox_mode"] = value(sandbox);
        }
        if !nicknames.is_empty() {
            agent_doc["nickname_candidates"] = toml_string_array(&nicknames);
        }

        prepared.push(PreparedCodexAgent {
            name: name.to_string(),
            filename: format!("{name}.toml"),
            role_description: description.to_string(),
            nickname_candidates: nicknames,
            toml: agent_doc.to_string(),
        });
    }

    Ok(prepared)
}

fn codex_agents_global_config(provider: &Provider) -> Result<AgentsGlobalConfig, String> {
    let global = provider.agents_config.clone().unwrap_or_default();
    if global.max_threads == 0 {
        return Err("Codex 子代理全局配置 maxThreads 必须大于 0".to_string());
    }
    if global.max_depth == 0 {
        return Err("Codex 子代理全局配置 maxDepth 必须大于 0".to_string());
    }
    if global.job_max_runtime_seconds == 0 {
        return Err("Codex 子代理全局配置 jobMaxRuntimeSeconds 必须大于 0".to_string());
    }
    Ok(global)
}

fn normalize_codex_agent_config_file(value: &str) -> String {
    value
        .trim()
        .replace('\\', "/")
        .trim_start_matches("./")
        .to_ascii_lowercase()
}

fn is_anybridge_agent_config_file(value: &str) -> bool {
    normalize_codex_agent_config_file(value).starts_with("anybridge-agents/")
}

fn read_codex_agents_manifest(config_path: &Path) -> Option<CodexAgentsManifest> {
    let manifest_path = codex_agents_manifest_path(config_path);
    let raw = fs::read_to_string(manifest_path).ok()?;
    serde_json::from_str(&raw).ok()
}

fn toml_item_u64(item: Option<&Item>) -> Option<u64> {
    item.and_then(Item::as_value)
        .and_then(|v| v.as_integer())
        .and_then(|v| u64::try_from(v).ok())
}

fn push_codex_cleanup_file(files: &mut Vec<String>, seen: &mut HashSet<String>, file: &str) {
    let Some(name) = Path::new(file).file_name().and_then(|s| s.to_str()) else {
        return;
    };
    if seen.insert(name.to_string()) {
        files.push(name.to_string());
    }
}

fn cleanup_anybridge_codex_agents(
    config_path: &Path,
    doc: &mut DocumentMut,
) -> Result<Vec<String>, String> {
    let manifest = read_codex_agents_manifest(config_path);
    let manifest_roles: HashSet<String> = manifest
        .as_ref()
        .map(|m| m.roles.iter().cloned().collect())
        .unwrap_or_default();
    let mut files_to_remove = Vec::new();
    let mut seen_files = HashSet::new();

    let mut remove_agents_table = false;
    if let Some(agents_table) = doc["agents"].as_table_mut() {
        let roles_to_remove: Vec<String> = agents_table
            .iter()
            .filter_map(|(name, item)| {
                let role_table = item.as_table()?;
                let managed_file = role_table
                    .get("config_file")
                    .and_then(Item::as_str)
                    .map(is_anybridge_agent_config_file)
                    .unwrap_or(false);
                if managed_file || manifest_roles.contains(name) {
                    Some(name.to_string())
                } else {
                    None
                }
            })
            .collect();
        for role in roles_to_remove {
            agents_table.remove(&role);
        }

        if let Some(manifest) = manifest.as_ref() {
            for (key, previous) in &manifest.managed_global {
                if toml_item_u64(agents_table.get(key)) == Some(*previous) {
                    agents_table.remove(key);
                }
            }
        }

        remove_agents_table = agents_table.iter().next().is_none();
    }
    if remove_agents_table {
        doc.as_table_mut().remove("agents");
    }

    let agents_dir = codex_agents_dir(config_path);
    if agents_dir.exists() {
        if let Some(manifest) = manifest.as_ref() {
            for file in &manifest.files {
                push_codex_cleanup_file(&mut files_to_remove, &mut seen_files, file);
            }
        } else if let Ok(entries) = fs::read_dir(&agents_dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.extension().and_then(|s| s.to_str()) == Some("toml") {
                    if let Some(name) = path.file_name().and_then(|s| s.to_str()) {
                        push_codex_cleanup_file(&mut files_to_remove, &mut seen_files, name);
                    }
                }
            }
        }
    }

    Ok(files_to_remove)
}

fn finalize_codex_agents_files(
    config_path: &Path,
    finalize: CodexAgentsFinalize,
) -> Result<(), String> {
    let agents_dir = codex_agents_dir(config_path);
    if let Some(manifest_json) = finalize.manifest_json {
        fs::create_dir_all(&agents_dir).map_err(|e| format!("创建 Codex 子代理目录失败: {e}"))?;
        super::write_atomic(
            &codex_agents_manifest_path(config_path),
            manifest_json.as_bytes(),
        )?;
    } else {
        let _ = fs::remove_file(codex_agents_manifest_path(config_path));
    }

    for file in finalize.files_to_remove {
        if finalize.keep_files.contains(&file) {
            continue;
        }
        let _ = fs::remove_file(agents_dir.join(file));
    }
    let _ = fs::remove_dir(&agents_dir);

    Ok(())
}

fn apply_codex_agents(
    config_path: &Path,
    doc: &mut DocumentMut,
    provider: &Provider,
) -> Result<CodexAgentsFinalize, String> {
    let prepared = prepare_codex_agents(provider)?;
    let global = if prepared.is_empty() {
        None
    } else {
        Some(codex_agents_global_config(provider)?)
    };
    let files_to_remove = cleanup_anybridge_codex_agents(config_path, doc)?;

    if prepared.is_empty() {
        return Ok(CodexAgentsFinalize::cleanup_only(files_to_remove));
    }

    let agents_dir = codex_agents_dir(config_path);
    fs::create_dir_all(&agents_dir).map_err(|e| format!("创建 Codex 子代理目录失败: {e}"))?;

    for agent in &prepared {
        super::write_atomic(&agents_dir.join(&agent.filename), agent.toml.as_bytes())?;
    }

    let global = global.expect("prepared agents require global config");
    let agents_table = doc
        .entry("agents")
        .or_insert(Item::Table(Table::new()))
        .as_table_mut()
        .ok_or_else(|| "config.toml 的 agents 字段不是表".to_string())?;
    agents_table["max_threads"] = value(global.max_threads as i64);
    agents_table["max_depth"] = value(global.max_depth as i64);
    agents_table["job_max_runtime_seconds"] = value(global.job_max_runtime_seconds as i64);

    for agent in &prepared {
        let role_table = agents_table
            .entry(&agent.name)
            .or_insert(Item::Table(Table::new()))
            .as_table_mut()
            .ok_or_else(|| format!("config.toml 的 agents.{} 不是表", agent.name))?;
        role_table["description"] = value(agent.role_description.clone());
        role_table["config_file"] = value(format!(
            "./{CODEX_ANYBRIDGE_AGENTS_DIRNAME}/{}",
            agent.filename
        ));
        if agent.nickname_candidates.is_empty() {
            role_table.remove("nickname_candidates");
        } else {
            role_table["nickname_candidates"] = toml_string_array(&agent.nickname_candidates);
        }
    }

    let mut managed_global = BTreeMap::new();
    managed_global.insert("max_threads".to_string(), global.max_threads as u64);
    managed_global.insert("max_depth".to_string(), global.max_depth as u64);
    managed_global.insert(
        "job_max_runtime_seconds".to_string(),
        global.job_max_runtime_seconds,
    );
    let manifest = CodexAgentsManifest {
        version: 1,
        roles: prepared.iter().map(|a| a.name.clone()).collect(),
        files: prepared.iter().map(|a| a.filename.clone()).collect(),
        managed_global,
    };
    let manifest_json = serde_json::to_string_pretty(&manifest)
        .map_err(|e| format!("Codex 子代理 manifest 序列化失败: {e}"))?;

    Ok(CodexAgentsFinalize {
        files_to_remove,
        keep_files: prepared.iter().map(|a| a.filename.clone()).collect(),
        manifest_json: Some(manifest_json),
    })
}

fn codex_proxy_route_source(provider_id: &str) -> String {
    format!("{CODEX_PROXY_ROUTE_SOURCE_PREFIX}{provider_id}")
}

fn codex_proxy_model_ids(provider: &Provider) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    let mut push = |value: &str| {
        let model = value.trim();
        if !model.is_empty() && seen.insert(model.to_string()) {
            out.push(model.to_string());
        }
    };

    push(&provider.default_model);
    for entry in &provider.model_catalog {
        push(&entry.model);
    }
    for model in &provider.models {
        push(model);
    }
    out
}

fn codex_proxy_route_display_name(provider: &Provider, model: &str) -> String {
    provider
        .model_catalog
        .iter()
        .find(|entry| entry.model == model)
        .and_then(|entry| entry.display_name.clone())
        .filter(|name| !name.trim().is_empty())
        .unwrap_or_else(|| model.to_string())
}

fn codex_proxy_target_api_path(provider: &Provider) -> String {
    let raw = provider
        .api_path
        .as_deref()
        .unwrap_or("/v1")
        .trim()
        .trim_end_matches('/');
    let base = if raw.is_empty() || raw == "/" {
        "/v1"
    } else {
        raw
    };
    let lower = base.to_ascii_lowercase();
    if lower.ends_with("/responses") || lower.ends_with("/chat/completions") {
        return base.to_string();
    }
    if provider.wire_api.trim().eq_ignore_ascii_case("chat") {
        format!("{base}/chat/completions")
    } else {
        format!("{base}/responses")
    }
}

fn plan_codex_proxy_routes(
    provider: &Provider,
) -> Result<super::proxy_routes::ProxyRoutes, String> {
    let models = codex_proxy_model_ids(provider);
    if models.is_empty() {
        return Err("Codex 代理模式至少需要一个模型，无法生成本地代理路由".to_string());
    }

    let mut routes = super::proxy_routes::read_codex_routes()?;
    let target_api_path = codex_proxy_target_api_path(provider);
    routes
        .routes
        .retain(|route| !route.source.starts_with(CODEX_PROXY_ROUTE_SOURCE_PREFIX));

    for model in models {
        if let Some(existing) = routes.routes.iter().find(|route| route.id == model) {
            return Err(format!(
                "Codex 模型「{}」与现有本地代理模型冲突（source: {}）。请先在「代理 > 模型列表」改名或删除该模型，再切换 Codex。",
                model,
                existing.source
            ));
        }

        routes.routes.push(super::proxy_routes::ProxyRoute {
            id: model.clone(),
            display_name: codex_proxy_route_display_name(provider, &model),
            id_from_rename_rule: false,
            enabled: true,
            exposed_formats: vec!["openai".to_string()],
            source: codex_proxy_route_source(&provider.id),
            capabilities: super::proxy_routes::ProxyRouteCapabilities {
                stream: provider.capabilities.stream,
                tools: provider.capabilities.tools,
                vision: provider.capabilities.vision,
                reasoning: true,
            },
            enhancement: super::proxy_routes::ProxyRouteEnhancement::default(),
            targets: vec![super::proxy_routes::ProxyRouteTarget {
                provider_id: provider.id.clone(),
                model,
                api_format: "openai".to_string(),
                api_path: target_api_path.clone(),
                unlock: String::new(),
                api_keys: Vec::new(),
            }],
        });
    }

    Ok(routes)
}

fn plan_clear_codex_proxy_routes() -> Result<super::proxy_routes::ProxyRoutes, String> {
    let mut routes = super::proxy_routes::read_codex_routes()?;
    routes
        .routes
        .retain(|route| !route.source.starts_with(CODEX_PROXY_ROUTE_SOURCE_PREFIX));
    Ok(routes)
}

struct LegacyGlobalCodexProxyRouteCleanupPlan {
    routes: Option<super::proxy_routes::ProxyRoutes>,
    warnings: Vec<String>,
}

fn legacy_global_codex_proxy_route_cleanup_warning(action: &str, error: &str) -> String {
    format!(
        "旧版 Codex 全局代理路由未清理：{action} proxy-routes.json 失败（{error}）。\
         Codex 现在使用独立 codex-proxy-routes.json，不影响本次 Codex 切换；\
         如需清理旧数据，请先修复「代理 > 模型列表」后重试。"
    )
}

fn plan_clear_legacy_global_codex_proxy_routes_from(
    routes: Result<super::proxy_routes::ProxyRoutes, String>,
) -> LegacyGlobalCodexProxyRouteCleanupPlan {
    let mut routes = match routes {
        Ok(routes) => routes,
        Err(e) => {
            return LegacyGlobalCodexProxyRouteCleanupPlan {
                routes: None,
                warnings: vec![legacy_global_codex_proxy_route_cleanup_warning("读取", &e)],
            }
        }
    };
    let before = routes.routes.len();
    routes
        .routes
        .retain(|route| !route.source.starts_with(CODEX_PROXY_ROUTE_SOURCE_PREFIX));
    if routes.routes.len() == before {
        LegacyGlobalCodexProxyRouteCleanupPlan {
            routes: None,
            warnings: Vec::new(),
        }
    } else {
        LegacyGlobalCodexProxyRouteCleanupPlan {
            routes: Some(routes),
            warnings: Vec::new(),
        }
    }
}

fn plan_clear_legacy_global_codex_proxy_routes() -> LegacyGlobalCodexProxyRouteCleanupPlan {
    plan_clear_legacy_global_codex_proxy_routes_from(super::proxy_routes::read_routes())
}

fn append_switch_warnings(message: &mut String, warnings: &[String]) {
    if warnings.is_empty() {
        return;
    }
    message.push_str("\n\n提示：");
    for warning in warnings {
        message.push_str("\n- ");
        message.push_str(warning);
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

fn toml_table_bool(table: &Table, key: &str) -> bool {
    table
        .get(key)
        .and_then(Item::as_value)
        .and_then(|value| value.as_bool())
        .unwrap_or(false)
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
    let requires_openai_auth = provider_table
        .map(|table| toml_table_bool(table, "requires_openai_auth"))
        .unwrap_or(false);
    // 统一会话历史下的官方模式：model_provider 固定为 codex_local_access，
    // 但 provider 走 OAuth、无 base_url/token，语义上仍是官方。
    let is_unified_official = model_provider_normalized == CODEX_RUNTIME_MODEL_PROVIDER_ID
        && requires_openai_auth
        && base_url.is_none()
        && !has_bearer_token;
    let is_builtin_or_named_official = model_provider_normalized.is_empty()
        || model_provider_normalized == "openai"
        || (provider_table
            .and_then(|table| toml_table_string(table, "name"))
            .map(|name| {
                let trimmed = name.trim();
                trimmed.eq_ignore_ascii_case("openai")
                    || trimmed == "OpenAI 官方"
            })
            .unwrap_or(false)
            && base_url.is_none()
            && !has_bearer_token);
    let is_official = is_builtin_or_named_official || is_unified_official;
    let managed_by_any_bridge = model_provider_id.as_deref()
        == Some(CODEX_LEGACY_MODEL_PROVIDER_ID)
        || provider_table
            .map(|table| toml_table_bool(table, CODEX_ANYBRIDGE_MANAGED_FLAG))
            .unwrap_or(false);

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

fn json_string_candidates(map: Option<&Map<String, Value>>, keys: &[&str]) -> Vec<String> {
    let Some(map) = map else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for key in keys {
        if let Some(value) = json_string(map, key) {
            if !out.iter().any(|existing| existing == &value) {
                out.push(value);
            }
        }
    }
    out
}

fn set_claude_model_env(env: &mut Map<String, Value>, model: &str) {
    for key in [
        "ANTHROPIC_MODEL",
        "ANTHROPIC_DEFAULT_HAIKU_MODEL",
        "ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME",
        "ANTHROPIC_DEFAULT_SONNET_MODEL",
        "ANTHROPIC_DEFAULT_SONNET_MODEL_NAME",
        "ANTHROPIC_DEFAULT_OPUS_MODEL",
        "ANTHROPIC_DEFAULT_OPUS_MODEL_NAME",
        "ANTHROPIC_DEFAULT_FABLE_MODEL",
        "ANTHROPIC_DEFAULT_FABLE_MODEL_NAME",
    ] {
        env.insert(key.to_string(), Value::String(model.to_string()));
    }
    env.remove("ANTHROPIC_SMALL_FAST_MODEL");
}

fn clone_claude_env_string(env: &Map<String, Value>, key: &str) -> Option<String> {
    env.get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn set_claude_env_if_missing(env: &mut Map<String, Value>, key: &str, value: Option<String>) {
    if env.get(key).and_then(Value::as_str).is_some() {
        return;
    }
    if let Some(value) = value {
        env.insert(key.to_string(), Value::String(value));
    }
}

fn normalize_claude_settings_model_env(settings: &mut Value, fallback_model: &str) {
    let Some(env) = settings.get_mut("env").and_then(Value::as_object_mut) else {
        return;
    };

    let fallback = {
        let fallback_model = fallback_model.trim();
        if fallback_model.is_empty() {
            None
        } else {
            Some(fallback_model.to_string())
        }
    };
    let primary = clone_claude_env_string(env, "ANTHROPIC_MODEL").or_else(|| fallback.clone());
    set_claude_env_if_missing(env, "ANTHROPIC_MODEL", primary.clone());

    let small_fast = clone_claude_env_string(env, "ANTHROPIC_SMALL_FAST_MODEL");
    let haiku = clone_claude_env_string(env, "ANTHROPIC_DEFAULT_HAIKU_MODEL")
        .or_else(|| clone_claude_env_string(env, "ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME"))
        .or_else(|| small_fast.clone())
        .or_else(|| primary.clone());
    let sonnet = clone_claude_env_string(env, "ANTHROPIC_DEFAULT_SONNET_MODEL")
        .or_else(|| clone_claude_env_string(env, "ANTHROPIC_DEFAULT_SONNET_MODEL_NAME"))
        .or_else(|| primary.clone())
        .or_else(|| small_fast.clone());
    let opus = clone_claude_env_string(env, "ANTHROPIC_DEFAULT_OPUS_MODEL")
        .or_else(|| clone_claude_env_string(env, "ANTHROPIC_DEFAULT_OPUS_MODEL_NAME"))
        .or_else(|| primary.clone())
        .or_else(|| small_fast.clone());
    let fable = clone_claude_env_string(env, "ANTHROPIC_DEFAULT_FABLE_MODEL")
        .or_else(|| clone_claude_env_string(env, "ANTHROPIC_DEFAULT_FABLE_MODEL_NAME"))
        .or_else(|| primary.clone())
        .or_else(|| opus.clone());

    set_claude_env_if_missing(env, "ANTHROPIC_DEFAULT_HAIKU_MODEL", haiku.clone());
    set_claude_env_if_missing(env, "ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME", haiku);
    set_claude_env_if_missing(env, "ANTHROPIC_DEFAULT_SONNET_MODEL", sonnet.clone());
    set_claude_env_if_missing(env, "ANTHROPIC_DEFAULT_SONNET_MODEL_NAME", sonnet);
    set_claude_env_if_missing(env, "ANTHROPIC_DEFAULT_OPUS_MODEL", opus.clone());
    set_claude_env_if_missing(env, "ANTHROPIC_DEFAULT_OPUS_MODEL_NAME", opus);
    set_claude_env_if_missing(env, "ANTHROPIC_DEFAULT_FABLE_MODEL", fable.clone());
    set_claude_env_if_missing(env, "ANTHROPIC_DEFAULT_FABLE_MODEL_NAME", fable);

    env.remove("ANTHROPIC_SMALL_FAST_MODEL");
}

fn read_claude_config_info(path: &PathBuf) -> Result<Option<ClaudeConfigInfo>, String> {
    if !path.exists() {
        return Ok(None);
    }

    let raw = fs::read_to_string(path).map_err(|e| e.to_string())?;
    if raw.trim().is_empty() {
        return Ok(Some(ClaudeConfigInfo {
            model: None,
            model_candidates: Vec::new(),
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
    let auth_token = first_json_string(env, CLAUDE_AUTH_ENV_KEYS);
    let model_candidates = json_string_candidates(env, CLAUDE_MODEL_ENV_KEYS);
    let model = model_candidates.first().cloned();
    let has_auth_token = auth_token.is_some();
    let is_official = base_url.is_none() && auth_token.is_none();

    Ok(Some(ClaudeConfigInfo {
        model,
        model_candidates,
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
        normalize_claude_settings_model_env(&mut out, &config.default_model);
        if mask_token {
            if let Some(value) = out.get_mut("apiKey") {
                if let Some(masked) = value.as_str().map(mask_key) {
                    *value = Value::String(masked);
                }
            }
            if let Some(env) = out.get_mut("env").and_then(Value::as_object_mut) {
                for key in CLAUDE_AUTH_ENV_KEYS {
                    if let Some(value) = env.get_mut(*key) {
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
    let provider_model = provider.default_model.trim();
    let same_model = provider_model.is_empty()
        || config.model_candidates.is_empty()
        || config
            .model_candidates
            .iter()
            .any(|model| model == provider_model);

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

fn buddy_display_name(p: &Provider, model_id: &str) -> String {
    // WorkBuddy / CodeBuddy UI 并排展示 name + id，name 只写供应商名，避免与 id 重复。
    // 例如 name="CPA"、id="grok-4.5" → 客户端显示 "CPA · grok-4.5"。
    let provider_name = p.name.trim();
    if !provider_name.is_empty() {
        provider_name.to_string()
    } else if !model_id.is_empty() {
        model_id.to_string()
    } else {
        let model = p.default_model.trim();
        if !model.is_empty() {
            model.to_string()
        } else {
            "model".to_string()
        }
    }
}

fn codebuddy_model_entry(p: &Provider, api_key: &str) -> Value {
    let model_id = codebuddy_model_id(p);
    let display_name = buddy_display_name(p, &model_id);

    let caps = p
        .model_caps
        .get(p.default_model.trim())
        .cloned()
        .unwrap_or_default();

    // 新版 WorkBuddy / CodeBuddy 仅当 vendor == "user" 时识别为自定义模型；
    // 写入供应商名会被归到「第三方模型」并可能覆盖官方同名模型。
    serde_json::json!({
        "id": model_id,
        "name": display_name,
        "vendor": "user",
        "apiKey": api_key,
        "maxInputTokens": recommend_context_window(&model_id),
        "maxOutputTokens": recommend_max_output_tokens(&model_id),
        "url": codebuddy_chat_url(p),
        "supportsToolCall": p.capabilities.tools || caps.tools,
        "supportsImages": p.capabilities.vision || caps.vision,
        "supportsReasoning": codebuddy_supports_reasoning(p.default_model.trim()),
    })
}

fn workbuddy_model_id(p: &Provider) -> String {
    // 与 CodeBuddy 一致：使用真实模型名作为 id，避免请求体 model=byok-xxx。
    codebuddy_model_id(p)
}

fn workbuddy_model_entry(p: &Provider, api_key: &str) -> Value {
    let model_id = workbuddy_model_id(p);
    let display_name = buddy_display_name(p, &model_id);

    let caps = p
        .model_caps
        .get(p.default_model.trim())
        .cloned()
        .unwrap_or_default();

    // WorkBuddy 在 useCustomProtocol=true 时不会再拼接路径，url 必须是完整
    // /v1/chat/completions 端点（与 codebuddy_chat_url 输出一致）。
    // vendor 必须是 "user"，否则新版会把条目归类为第三方模型。
    serde_json::json!({
        "id": model_id,
        "name": display_name,
        "vendor": "user",
        "apiKey": api_key,
        "maxInputTokens": recommend_context_window(&model_id),
        "maxOutputTokens": recommend_max_output_tokens(&model_id),
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

fn opencode_default_model_key(config: &OpenCodeConfig, settings: &Value) -> Result<String, String> {
    let default_model = config.default_model.trim();
    if let Some(models) = settings.get("models").and_then(Value::as_object) {
        if !default_model.is_empty() && models.contains_key(default_model) {
            return Ok(default_model.to_string());
        }
        if let Some(model) = models.keys().find_map(|key| {
            let trimmed = key.trim();
            (!trimmed.is_empty()).then(|| trimmed.to_string())
        }) {
            return Ok(model);
        }
    }

    if !default_model.is_empty() {
        return Ok(default_model.to_string());
    }

    config
        .models
        .iter()
        .find_map(|model| {
            let trimmed = model.trim();
            (!trimmed.is_empty()).then(|| trimmed.to_string())
        })
        .ok_or_else(|| "OpenCode 配置缺少默认模型，无法设置当前 model".to_string())
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

    let settings = opencode_settings_from_config(config, false);
    if !settings.is_object() {
        return Err("OpenCode provider 配置 JSON 顶层必须是对象".to_string());
    }
    let model_key = opencode_default_model_key(config, &settings)?;

    let provider_value = obj
        .entry("provider")
        .or_insert_with(|| Value::Object(Map::new()));
    let provider_obj = provider_value
        .as_object_mut()
        .ok_or_else(|| "opencode.json 的 provider 字段不是对象".to_string())?;
    provider_obj.insert(config.id.clone(), settings);
    obj.insert(
        "model".to_string(),
        Value::String(format!("{}/{}", config.id, model_key)),
    );

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

/// 主流模型推荐上下文配置（与 ui/assets/model-context-presets.json 对齐）。
/// 编译期嵌入 JSON，避免运行时路径/CWD 依赖与双份漂移。
#[derive(Debug, Clone, serde::Deserialize)]
struct ModelContextDefaults {
    #[serde(rename = "maxInputTokens", default = "default_max_input")]
    max_input_tokens: u64,
    #[serde(rename = "maxOutputTokens", default = "default_max_output")]
    max_output_tokens: u64,
}

fn default_max_input() -> u64 {
    128_000
}
fn default_max_output() -> u64 {
    8_192
}

impl Default for ModelContextDefaults {
    fn default() -> Self {
        Self {
            max_input_tokens: default_max_input(),
            max_output_tokens: default_max_output(),
        }
    }
}

#[derive(Debug, Clone, serde::Deserialize)]
struct ModelContextModelEntry {
    id: Option<String>,
    #[serde(rename = "match")]
    match_field: Option<Vec<String>>,
    #[serde(rename = "maxInputTokens")]
    max_input_tokens: Option<u64>,
    #[serde(rename = "maxOutputTokens")]
    max_output_tokens: Option<u64>,
}

#[derive(Debug, Clone, serde::Deserialize)]
struct ModelContextPatternEntry {
    id: Option<String>,
    #[serde(rename = "includesAny")]
    includes_any: Option<Vec<String>>,
    #[serde(rename = "requiresAny")]
    requires_any: Option<Vec<String>>,
    #[serde(rename = "maxInputTokens")]
    max_input_tokens: Option<u64>,
    #[serde(rename = "maxOutputTokens")]
    max_output_tokens: Option<u64>,
}

#[derive(Debug, Clone, serde::Deserialize, Default)]
struct ModelContextPresets {
    #[serde(default)]
    defaults: ModelContextDefaults,
    #[serde(default)]
    models: Vec<ModelContextModelEntry>,
    #[serde(default)]
    patterns: Vec<ModelContextPatternEntry>,
}

const MODEL_CONTEXT_PRESETS_JSON: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/resources/model-context-presets.json"
));

fn load_model_context_presets() -> ModelContextPresets {
    match serde_json::from_str::<ModelContextPresets>(MODEL_CONTEXT_PRESETS_JSON) {
        Ok(parsed) => parsed,
        Err(err) => {
            eprintln!(
                "[model-context-presets] 内置 JSON 解析失败，回退默认值: {err}"
            );
            ModelContextPresets::default()
        }
    }
}

fn model_context_presets() -> &'static ModelContextPresets {
    use std::sync::OnceLock;
    static PRESETS: OnceLock<ModelContextPresets> = OnceLock::new();
    PRESETS.get_or_init(load_model_context_presets)
}

fn normalize_model_id(model_id: &str) -> String {
    model_id
        .to_ascii_lowercase()
        .chars()
        .map(|c| if c.is_whitespace() { '-' } else { c })
        .collect()
}

/// 短 token / 版本碎片：只允许精确或前缀匹配，避免 o1、m2.7、seed 误伤。
fn is_ambiguous_token(token: &str) -> bool {
    let t = token.to_ascii_lowercase();
    if t.is_empty() || t.len() <= 3 {
        return true;
    }
    if t.len() < 5 && !t.contains('-') && !t.contains('_') && !t.contains('/') {
        return true;
    }
    // m2.7 / k2.5 / o1.5
    let bytes = t.as_bytes();
    let mut i = 0;
    while i < bytes.len() && bytes[i].is_ascii_alphabetic() {
        i += 1;
    }
    if i > 2 {
        return false;
    }
    if i == bytes.len() {
        return false;
    }
    let rest = &t[i..];
    if rest.is_empty() {
        return false;
    }
    rest.chars().all(|c| c.is_ascii_digit() || c == '.')
        && rest.contains('.')
        && rest.chars().any(|c| c.is_ascii_digit())
}

fn is_boundary_char(c: char) -> bool {
    !c.is_ascii_alphanumeric()
}

/// 边界匹配：token 必须是完整片段（两侧为非字母数字或边界）。
fn token_matches(id: &str, token: &str) -> bool {
    let t = token.to_ascii_lowercase();
    if t.is_empty() {
        return false;
    }
    if id == t {
        return true;
    }
    if is_ambiguous_token(&t) {
        return id.starts_with(&format!("{t}-"))
            || id.starts_with(&format!("{t}."))
            || id.starts_with(&format!("{t}_"));
    }
    let mut start = 0;
    while let Some(rel) = id[start..].find(&t) {
        let idx = start + rel;
        let before_ok = idx == 0
            || id[..idx]
                .chars()
                .next_back()
                .map(is_boundary_char)
                .unwrap_or(true);
        let after_idx = idx + t.len();
        let after_ok = after_idx >= id.len()
            || id[after_idx..]
                .chars()
                .next()
                .map(is_boundary_char)
                .unwrap_or(true);
        if before_ok && after_ok {
            return true;
        }
        start = idx + 1;
        if start >= id.len() {
            break;
        }
    }
    false
}

fn list_hit(id: &str, list: &[String]) -> bool {
    list.iter().any(|token| token_matches(id, token))
}

fn score_match(id: &str, token: &str) -> i32 {
    let t = token.to_ascii_lowercase();
    if t.is_empty() {
        return -1;
    }
    if id == t {
        return 1000 + t.len() as i32;
    }
    if !token_matches(id, &t) {
        return -1;
    }
    if id.starts_with(&t) {
        return 200 + t.len() as i32;
    }
    100 + t.len() as i32
}

fn resolve_model_context_preset(model_id: &str) -> (u64, u64) {
    let presets = model_context_presets();
    let defaults = &presets.defaults;
    let id = normalize_model_id(model_id);
    if id.is_empty() {
        return (defaults.max_input_tokens, defaults.max_output_tokens);
    }

    // 精确/边界模型表：取最高分
    let mut best_score = -1;
    let mut best_in = defaults.max_input_tokens;
    let mut best_out = defaults.max_output_tokens;
    for entry in &presets.models {
        let tokens: Vec<String> = entry
            .match_field
            .clone()
            .unwrap_or_else(|| entry.id.clone().into_iter().collect());
        for token in tokens {
            let score = score_match(&id, &token);
            if score > best_score {
                best_score = score;
                best_in = entry.max_input_tokens.unwrap_or(defaults.max_input_tokens);
                best_out = entry.max_output_tokens.unwrap_or(defaults.max_output_tokens);
            }
        }
    }
    if best_score >= 0 {
        return (best_in, best_out);
    }

    // 模式表：按顺序首个命中
    for entry in &presets.patterns {
        let includes = entry.includes_any.clone().unwrap_or_default();
        if includes.is_empty() || !list_hit(&id, &includes) {
            continue;
        }
        let requires = entry.requires_any.clone().unwrap_or_default();
        if !requires.is_empty() && !list_hit(&id, &requires) {
            continue;
        }
        return (
            entry.max_input_tokens.unwrap_or(defaults.max_input_tokens),
            entry.max_output_tokens.unwrap_or(defaults.max_output_tokens),
        );
    }

    (defaults.max_input_tokens, defaults.max_output_tokens)
}

/// 按模型 ID 推断推荐上下文窗口（优先读 model-context-presets.json）。
fn recommend_context_window(model_id: &str) -> u64 {
    resolve_model_context_preset(model_id).0
}

fn recommend_max_output_tokens(model_id: &str) -> u64 {
    resolve_model_context_preset(model_id).1
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
    let context = recommend_context_window(&model_id);

    let mut model_meta = Map::new();
    model_meta.insert(
        "limit".to_string(),
        serde_json::json!({
            "context": context,
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
        .unwrap_or_else(|| recommend_context_window(&model_id));
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
pub fn switch_platform(
    app: AppHandle,
    platform: String,
    provider_id: String,
) -> Result<SwitchResult, String> {
    let plat = Platform::from_id(&platform).ok_or_else(|| format!("未知平台: {platform}"))?;
    emit_switch_progress(&app, plat.id(), "reading", "正在读取供应商配置…");
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
        emit_switch_progress(&app, plat.id(), "backup", "正在备份原配置文件…");
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("创建配置目录失败: {e}"))?;
        }
        ensure_backup(&path)?;
        emit_switch_progress(&app, plat.id(), "writing", "正在写入 Claude Code 配置…");
        apply_claude_config_file(&path, &config)?;

        let config_path = path.to_string_lossy().to_string();
        let backup = backup_path(&path).to_string_lossy().to_string();
        emit_switch_progress(&app, plat.id(), "saving", "正在保存接管状态…");
        store.platforms.insert(
            plat.id().to_string(),
            PlatformState {
                provider_id: config.id.clone(),
                applied_at: now_epoch_secs(),
            },
        );
        write_provider_store(&store)?;
        emit_switch_progress(&app, plat.id(), "done", "切换完成");

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
        emit_switch_progress(&app, plat.id(), "backup", "正在备份原配置文件…");
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("创建配置目录失败: {e}"))?;
        }
        ensure_backup(&path)?;
        emit_switch_progress(&app, plat.id(), "writing", "正在写入 OpenCode 配置…");
        apply_opencode_config_file(&path, &config)?;

        let config_path = path.to_string_lossy().to_string();
        let backup = backup_path(&path).to_string_lossy().to_string();
        emit_switch_progress(&app, plat.id(), "done", "设置完成");

        return Ok(SwitchResult {
            ok: true,
            message: format!(
                "已将 OpenCode 配置「{}」加入 live provider 列表，并设为当前 model，新会话或重启 OpenCode 后生效",
                config.name
            ),
            config_path,
            backup_path: backup,
        });
    }

    emit_switch_progress(&app, plat.id(), "resolving", "正在解析供应商信息…");
    let provider = resolve_platform_config(&plat, &store, &provider_id)?;
    let planned_codex_routes = if matches!(plat, Platform::Codex) {
        emit_switch_progress(&app, plat.id(), "routing", "正在校验 Codex 本地代理路由…");
        Some(if provider.route_through_proxy {
            plan_codex_proxy_routes(&provider)?
        } else {
            plan_clear_codex_proxy_routes()?
        })
    } else {
        None
    };
    let (planned_legacy_global_codex_routes, mut codex_cleanup_warnings) =
        if matches!(plat, Platform::Codex) {
            let plan = plan_clear_legacy_global_codex_proxy_routes();
            for warning in &plan.warnings {
                emit_switch_progress(&app, plat.id(), "warning", warning);
            }
            (plan.routes, plan.warnings)
        } else {
            (None, Vec::new())
        };

    emit_switch_progress(&app, plat.id(), "backup", "正在备份原配置文件…");
    let path = plat.apply(&provider)?;
    let config_path = path.to_string_lossy().to_string();
    let backup = backup_path(&path).to_string_lossy().to_string();

    if let Some(routes) = planned_codex_routes.as_ref() {
        emit_switch_progress(&app, plat.id(), "routing", "正在写入 Codex 本地代理路由…");
        super::proxy_routes::write_codex_routes(routes)?;
    }
    if let Some(routes) = planned_legacy_global_codex_routes.as_ref() {
        emit_switch_progress(
            &app,
            plat.id(),
            "routing",
            "正在清理旧版 Codex 全局代理路由…",
        );
        if let Err(e) = super::proxy_routes::write_routes(routes) {
            let warning = legacy_global_codex_proxy_route_cleanup_warning("写入", &e);
            emit_switch_progress(&app, plat.id(), "warning", &warning);
            codex_cleanup_warnings.push(warning);
        }
    }

    if !matches!(plat, Platform::OpenCode) {
        emit_switch_progress(&app, plat.id(), "saving", "正在保存接管状态…");
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
            "已将 OpenCode 配置「{}」加入 live provider 列表，并设为当前 model，新会话或重启 OpenCode 后生效",
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
        append_switch_warnings(&mut message, &codex_cleanup_warnings);
    }

    emit_switch_progress(&app, plat.id(), "done", "切换完成");
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
    let cleared_current_model = obj
        .get("model")
        .and_then(Value::as_str)
        .map(|model| model.starts_with(&format!("{provider_id}/")))
        .unwrap_or(false);
    if cleared_current_model {
        obj.remove("model");
    }

    let json = serde_json::to_string_pretty(&Value::Object(obj)).map_err(|e| e.to_string())?;
    super::write_atomic(&path, json.as_bytes())?;

    let config_path = path.to_string_lossy().to_string();
    let backup = backup_path(&path).to_string_lossy().to_string();
    Ok(SwitchResult {
        ok: true,
        message: if cleared_current_model {
            format!(
                "已从 OpenCode live 配置移除「{}」，并清除指向它的当前 model",
                provider_id
            )
        } else {
            format!("已从 OpenCode live 配置移除「{}」", provider_id)
        },
        config_path,
        backup_path: backup,
    })
}

/// 从备份还原平台配置（回到 AnyBridge 接管前的状态），并清除接管记录。
#[tauri::command]
pub fn restore_platform(app: AppHandle, platform: String) -> Result<bool, String> {
    let plat = Platform::from_id(&platform).ok_or_else(|| format!("未知平台: {platform}"))?;
    emit_switch_progress(&app, plat.id(), "backup", "正在从备份还原配置…");
    let restored = plat.restore()?;

    emit_switch_progress(&app, plat.id(), "saving", "正在清除接管记录…");
    // 无论是否有备份，都清除接管记录（接管状态以备份为准）。
    if let Ok(mut store) = read_provider_store() {
        if store.platforms.remove(plat.id()).is_some() {
            let _ = write_provider_store(&store);
        }
    }
    emit_switch_progress(&app, plat.id(), "done", "还原完成");
    Ok(restored)
}

/// 切回 Claude Code 官方环境：清理 AnyBridge 写入的 ANTHROPIC_* env 字段，保留其他设置。
#[tauri::command]
pub fn restore_claude_official_config(app: AppHandle) -> Result<SwitchResult, String> {
    let plat = Platform::ClaudeCode;
    emit_switch_progress(&app, plat.id(), "backup", "正在备份当前配置…");
    let path = plat
        .config_path()
        .ok_or_else(|| "无法定位用户主目录".to_string())?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建配置目录失败: {e}"))?;
    }
    if path.exists() {
        ensure_backup(&path)?;
    }
    emit_switch_progress(&app, plat.id(), "writing", "正在写入官方配置…");
    plat.apply_claude_official(&path)?;

    emit_switch_progress(&app, plat.id(), "saving", "正在清除接管记录…");
    if let Ok(mut store) = read_provider_store() {
        if store.platforms.remove(plat.id()).is_some() {
            let _ = write_provider_store(&store);
        }
    }

    let config_path = path.to_string_lossy().to_string();
    let backup = backup_path(&path).to_string_lossy().to_string();
    emit_switch_progress(&app, plat.id(), "done", "已切回官方配置");
    Ok(SwitchResult {
        ok: true,
        message: "已切回 Claude Code 官方配置，重启 Claude Code 后生效".to_string(),
        config_path,
        backup_path: backup,
    })
}

/// 切回 Codex 官方 OpenAI 配置：不依赖 .byok-bak，不修改 auth.json。
#[tauri::command]
pub fn restore_codex_official_config(app: AppHandle) -> Result<SwitchResult, String> {
    let plat = Platform::Codex;
    let store = read_provider_store()?;
    emit_switch_progress(&app, plat.id(), "backup", "正在备份当前配置…");
    let path = plat
        .config_path()
        .ok_or_else(|| "无法定位用户主目录".to_string())?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建配置目录失败: {e}"))?;
    }
    ensure_backup(&path)?;
    crate::commands::codex_desktop::clean_models_cache()?;
    emit_switch_progress(&app, plat.id(), "routing", "正在清理 Codex 本地代理路由…");
    let planned_routes = plan_clear_codex_proxy_routes()?;
    let legacy_cleanup_plan = plan_clear_legacy_global_codex_proxy_routes();
    let mut codex_cleanup_warnings = legacy_cleanup_plan.warnings;
    for warning in &codex_cleanup_warnings {
        emit_switch_progress(&app, plat.id(), "warning", warning);
    }
    emit_switch_progress(&app, plat.id(), "writing", "正在写入官方配置…");
    // 查找当前活跃的 Codex 配置，读取其 unify_session_history 标志（默认 true）
    let unify_session_history = store
        .platforms
        .get(plat.id())
        .and_then(|state| {
            store
                .codex_configs
                .iter()
                .find(|c| c.id == state.provider_id)
        })
        .map(|c| c.unify_session_history)
        .unwrap_or(true);
    plat.apply_codex_official(&path, unify_session_history)?;
    super::proxy_routes::write_codex_routes(&planned_routes)?;
    if let Some(routes) = legacy_cleanup_plan.routes.as_ref() {
        if let Err(e) = super::proxy_routes::write_routes(routes) {
            let warning = legacy_global_codex_proxy_route_cleanup_warning("写入", &e);
            emit_switch_progress(&app, plat.id(), "warning", &warning);
            codex_cleanup_warnings.push(warning);
        }
    }

    emit_switch_progress(&app, plat.id(), "saving", "正在清除接管记录…");
    if let Ok(mut store) = read_provider_store() {
        if store.platforms.remove(plat.id()).is_some() {
            let _ = write_provider_store(&store);
        }
    }

    let config_path = path.to_string_lossy().to_string();
    let backup = backup_path(&path).to_string_lossy().to_string();
    let mut message = "已切回 Codex 官方 OpenAI 配置，重启 Codex 后生效".to_string();
    message.push_str(&repair_codex_session_visibility_message(&path));
    append_switch_warnings(&mut message, &codex_cleanup_warnings);
    emit_switch_progress(&app, plat.id(), "done", "已切回官方配置");
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

/// 保存 CodeBuddy / WorkBuddy models.json（原子写 + 自动备份）。
///
/// `available_models` 参数保留以兼容前端调用，但**刻意不写入磁盘**。
/// 客户端对 `availableModels` 字符串数组做 SmartMerge 时是整表替换；
/// 若只含自定义模型 id，随后 AvailableModelsFilter 会把官方模型全部过滤掉。
#[tauri::command]
pub fn save_codebuddy_models(
    platform: String,
    models: Vec<serde_json::Value>,
    available_models: Vec<String>,
    scope: Option<String>,
) -> Result<String, String> {
    let _ = available_models; // 兼容旧前端参数；勿写回 models.json

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
        Ok(summary) => {
            // 没有改动时不追加冗余信息
            if summary.updated_sqlite_row_count == 0 {
                String::new()
            } else {
                format!("。{}", summary.message)
            }
        }
        Err(error) => format!(
            "。但恢复历史会话可见性失败：{}。配置已写入，可关闭 Codex 后重试切换",
            error
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::config::{
        AgentsGlobalConfig, ApiFormat, CodexAgent, ProviderCapabilities, ProviderUnlocks,
    };
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

    fn temp_json_path(name: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("anybridge-{name}-{nanos}"));
        fs::create_dir_all(&dir).unwrap();
        dir.join("settings.json")
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
            unlocks: ProviderUnlocks::default(),
            wire_api: String::new(),
            route_through_proxy: true,
            inject_models: true,
            preserve_official_auth: false,
            unify_session_history: true,
            model_catalog: Vec::new(),
            codex_chat_reasoning: None,
            agents_config: None,
            agents: Vec::new(),
        }
    }

    fn test_claude_provider() -> Provider {
        Provider {
            id: "claude-provider-1".to_string(),
            name: "Claude Test Provider".to_string(),
            api_host: "https://anthropic.example.com".to_string(),
            api_key: "sk-ant-test-secret".to_string(),
            api_path: None,
            default_model: "claude-test-model".to_string(),
            api_format: ApiFormat::Anthropic,
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
            unlocks: ProviderUnlocks::default(),
            wire_api: String::new(),
            route_through_proxy: true,
            inject_models: true,
            preserve_official_auth: false,
            unify_session_history: true,
            model_catalog: Vec::new(),
            codex_chat_reasoning: None,
            agents_config: None,
            agents: Vec::new(),
        }
    }

    #[test]
    fn codex_proxy_target_api_path_matches_wire_api() {
        let mut provider = test_openai_provider();
        provider.api_path = Some("/v1".to_string());
        provider.wire_api = "responses".to_string();
        assert_eq!(codex_proxy_target_api_path(&provider), "/v1/responses");

        provider.wire_api = "chat".to_string();
        assert_eq!(
            codex_proxy_target_api_path(&provider),
            "/v1/chat/completions"
        );

        provider.api_path = Some("/custom/responses".to_string());
        provider.wire_api = "chat".to_string();
        assert_eq!(codex_proxy_target_api_path(&provider), "/custom/responses");
    }

    fn test_proxy_route(id: &str, source: &str) -> crate::commands::proxy_routes::ProxyRoute {
        crate::commands::proxy_routes::ProxyRoute {
            id: id.to_string(),
            display_name: id.to_string(),
            enabled: true,
            exposed_formats: vec!["openai".to_string()],
            source: source.to_string(),
            targets: vec![crate::commands::proxy_routes::ProxyRouteTarget {
                provider_id: "provider-1".to_string(),
                model: id.to_string(),
                api_format: "openai".to_string(),
                ..Default::default()
            }],
            ..Default::default()
        }
    }

    #[test]
    fn legacy_global_codex_cleanup_read_error_warns_without_blocking() {
        let plan = plan_clear_legacy_global_codex_proxy_routes_from(Err("bad json".to_string()));

        assert!(plan.routes.is_none());
        assert_eq!(plan.warnings.len(), 1);
        assert!(plan.warnings[0].contains("读取 proxy-routes.json 失败"));
        assert!(plan.warnings[0].contains("不影响本次 Codex 切换"));
    }

    #[test]
    fn legacy_global_codex_cleanup_removes_only_old_codex_routes() {
        let plan = plan_clear_legacy_global_codex_proxy_routes_from(Ok(
            crate::commands::proxy_routes::ProxyRoutes {
                version: 1,
                default_model_id: String::new(),
                routes: vec![
                    test_proxy_route("deepseek-v4-flash", "codex:deepseek"),
                    test_proxy_route("manual-model", "manual"),
                ],
            },
        ));

        assert!(plan.warnings.is_empty());
        let routes = plan.routes.expect("旧版 codex:* route 应触发清理写回");
        assert_eq!(routes.routes.len(), 1);
        assert_eq!(routes.routes[0].id, "manual-model");
        assert_eq!(routes.routes[0].source, "manual");
    }

    #[test]
    fn apply_claude_writes_complete_model_env_and_preserves_settings() {
        let path = temp_json_path("claude-apply");
        fs::write(
            &path,
            r#"{
  "language": "zh-CN",
  "permissions": { "allow": ["Bash"] },
  "hooks": { "PostToolUse": [] },
  "env": {
    "ANTHROPIC_SMALL_FAST_MODEL": "legacy-fast",
    "MCP_TIMEOUT": "120000"
  }
}"#,
        )
        .unwrap();

        Platform::ClaudeCode
            .apply_claude(&path, &test_claude_provider())
            .unwrap();

        let raw = fs::read_to_string(&path).unwrap();
        let value: Value = serde_json::from_str(&raw).unwrap();
        let env = value.get("env").and_then(Value::as_object).unwrap();
        assert_eq!(
            env.get("ANTHROPIC_BASE_URL").and_then(Value::as_str),
            Some("https://anthropic.example.com")
        );
        assert_eq!(
            env.get("ANTHROPIC_AUTH_TOKEN").and_then(Value::as_str),
            Some("sk-ant-test-secret")
        );
        for key in [
            "ANTHROPIC_MODEL",
            "ANTHROPIC_DEFAULT_HAIKU_MODEL",
            "ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME",
            "ANTHROPIC_DEFAULT_SONNET_MODEL",
            "ANTHROPIC_DEFAULT_SONNET_MODEL_NAME",
            "ANTHROPIC_DEFAULT_OPUS_MODEL",
            "ANTHROPIC_DEFAULT_OPUS_MODEL_NAME",
            "ANTHROPIC_DEFAULT_FABLE_MODEL",
            "ANTHROPIC_DEFAULT_FABLE_MODEL_NAME",
        ] {
            assert_eq!(
                env.get(key).and_then(Value::as_str),
                Some("claude-test-model"),
                "{key} should be written"
            );
        }
        assert!(env.get("ANTHROPIC_SMALL_FAST_MODEL").is_none());
        assert_eq!(
            env.get("MCP_TIMEOUT").and_then(Value::as_str),
            Some("120000")
        );
        assert_eq!(value.get("language").and_then(Value::as_str), Some("zh-CN"));
        assert!(value.get("permissions").is_some());
        assert!(value.get("hooks").is_some());

        let _ = fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn apply_claude_config_file_normalizes_old_saved_settings_config() {
        let path = temp_json_path("claude-settings-config");
        fs::write(
            &path,
            r#"{
  "env": {
    "ANTHROPIC_DEFAULT_FABLE_MODEL": "stale-fable",
    "ANTHROPIC_DEFAULT_FABLE_MODEL_NAME": "stale-fable"
  },
  "permissions": { "allow": ["Read"] }
}"#,
        )
        .unwrap();

        let config = ClaudeCodeConfig {
            id: "claude-config-1".to_string(),
            name: "Saved Claude".to_string(),
            api_host: "https://saved.example.com".to_string(),
            api_key: "sk-saved".to_string(),
            api_path: None,
            default_model: "claude-saved-model".to_string(),
            models: Vec::new(),
            settings_config: Some(serde_json::json!({
                "env": {
                    "ANTHROPIC_BASE_URL": "https://saved.example.com",
                    "ANTHROPIC_AUTH_TOKEN": "sk-saved",
                    "ANTHROPIC_MODEL": "claude-saved-model"
                }
            })),
            source_provider_id: String::new(),
            source_provider_name: String::new(),
        };

        apply_claude_config_file(&path, &config).unwrap();

        let raw = fs::read_to_string(&path).unwrap();
        let value: Value = serde_json::from_str(&raw).unwrap();
        let env = value.get("env").and_then(Value::as_object).unwrap();
        assert_eq!(
            env.get("ANTHROPIC_DEFAULT_FABLE_MODEL")
                .and_then(Value::as_str),
            Some("claude-saved-model")
        );
        assert_eq!(
            env.get("ANTHROPIC_DEFAULT_FABLE_MODEL_NAME")
                .and_then(Value::as_str),
            Some("claude-saved-model")
        );
        assert_eq!(
            env.get("ANTHROPIC_DEFAULT_SONNET_MODEL_NAME")
                .and_then(Value::as_str),
            Some("claude-saved-model")
        );
        assert!(value.get("permissions").is_some());

        let _ = fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn restore_claude_official_removes_all_managed_env_fields() {
        let path = temp_json_path("claude-restore");
        fs::write(
            &path,
            r#"{
  "language": "zh-CN",
  "env": {
    "ANTHROPIC_BASE_URL": "https://third-party.example.com",
    "ANTHROPIC_AUTH_TOKEN": "sk-token",
    "ANTHROPIC_API_KEY": "sk-api",
    "OPENROUTER_API_KEY": "sk-openrouter",
    "GOOGLE_API_KEY": "sk-google",
    "ANTHROPIC_MODEL": "claude-third-party",
    "ANTHROPIC_REASONING_MODEL": "claude-reasoning",
    "ANTHROPIC_SMALL_FAST_MODEL": "legacy-fast",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "claude-haiku",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME": "claude-haiku",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "claude-sonnet",
    "ANTHROPIC_DEFAULT_SONNET_MODEL_NAME": "claude-sonnet",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "claude-opus",
    "ANTHROPIC_DEFAULT_OPUS_MODEL_NAME": "claude-opus",
    "ANTHROPIC_DEFAULT_FABLE_MODEL": "claude-fable",
    "ANTHROPIC_DEFAULT_FABLE_MODEL_NAME": "claude-fable",
    "MCP_TIMEOUT": "120000"
  }
}"#,
        )
        .unwrap();

        Platform::ClaudeCode.apply_claude_official(&path).unwrap();

        let raw = fs::read_to_string(&path).unwrap();
        let value: Value = serde_json::from_str(&raw).unwrap();
        let env = value.get("env").and_then(Value::as_object).unwrap();
        for key in CLAUDE_MANAGED_ENV_KEYS {
            assert!(env.get(*key).is_none(), "{key} should be removed");
        }
        assert_eq!(
            env.get("MCP_TIMEOUT").and_then(Value::as_str),
            Some("120000")
        );
        assert_eq!(value.get("language").and_then(Value::as_str), Some("zh-CN"));

        let _ = fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn claude_provider_match_uses_all_model_candidates() {
        let provider = test_claude_provider();
        let info = ClaudeConfigInfo {
            model: Some("stale-primary".to_string()),
            model_candidates: vec!["stale-primary".to_string(), "claude-test-model".to_string()],
            base_url: Some("https://anthropic.example.com/v1/messages".to_string()),
            has_auth_token: true,
            auth_token_masked: Some("sk-...cret".to_string()),
            is_official: false,
            managed_by_any_bridge: false,
        };

        assert!(claude_provider_matches_config(&info, &provider));
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
        let expected_codex_base = codex_base_url();
        let expected_codex_bearer = codex_bearer_token().unwrap();
        assert_eq!(doc["model"].as_str(), Some("gpt-test"));
        assert_eq!(
            doc["model_provider"].as_str(),
            Some(CODEX_RUNTIME_MODEL_PROVIDER_ID)
        );
        assert_eq!(
            doc["model_providers"][CODEX_RUNTIME_MODEL_PROVIDER_ID]["base_url"].as_str(),
            Some(expected_codex_base.as_str())
        );
        assert_eq!(
            doc["model_providers"][CODEX_RUNTIME_MODEL_PROVIDER_ID]["experimental_bearer_token"]
                .as_str(),
            Some(expected_codex_bearer.as_str())
        );
        assert_eq!(
            doc["model_providers"][CODEX_RUNTIME_MODEL_PROVIDER_ID]["requires_openai_auth"]
                .as_bool(),
            Some(false)
        );
        assert!(
            doc["model_providers"][CODEX_RUNTIME_MODEL_PROVIDER_ID]
                .as_table()
                .unwrap()
                .get("env_key")
                .is_none()
        );
        assert!(
            doc["model_providers"][CODEX_RUNTIME_MODEL_PROVIDER_ID]
                .as_table()
                .unwrap()
                .get("auth")
                .is_none()
        );
        assert_eq!(
            doc["model_providers"][CODEX_RUNTIME_MODEL_PROVIDER_ID][CODEX_ANYBRIDGE_MANAGED_FLAG]
                .as_bool(),
            Some(true)
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
    fn apply_codex_clears_conflicting_oauth_and_bearer_fields() {
        let path = temp_config_path("codex-auth-conflict");
        fs::write(
            &path,
            r#"
model = "stale-model"
model_provider = "codex_local_access"

[model_providers.codex_local_access]
name = "AnyRouter"
base_url = "https://anyrouter.top/v1"
wire_api = "responses"
requires_openai_auth = true
env_key = "OPENAI_API_KEY"
experimental_bearer_token = "sk-stale-conflict"
anybridge_managed = true

[model_providers.codex_local_access.auth]
command = "echo"
args = ["token"]
"#,
        )
        .unwrap();

        let provider = test_openai_provider();
        Platform::Codex.apply_codex(&path, &provider).unwrap();

        let raw = fs::read_to_string(&path).unwrap();
        let doc = raw.parse::<DocumentMut>().unwrap();
        let provider = doc["model_providers"][CODEX_RUNTIME_MODEL_PROVIDER_ID]
            .as_table()
            .unwrap();
        let expected_codex_bearer = codex_bearer_token().unwrap();

        assert_eq!(
            provider.get("requires_openai_auth").and_then(|v| v.as_bool()),
            Some(false)
        );
        assert_eq!(
            provider
                .get("experimental_bearer_token")
                .and_then(|v| v.as_str()),
            Some(expected_codex_bearer.as_str())
        );
        assert!(provider.get("env_key").is_none());
        assert!(provider.get("auth").is_none());

        let _ = fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn apply_codex_official_strips_bearer_when_enabling_oauth() {
        let path = temp_config_path("codex-oauth-from-conflict");
        fs::write(
            &path,
            r#"
model = "third-party"
model_provider = "codex_local_access"

[model_providers.codex_local_access]
name = "AnyRouter"
base_url = "https://anyrouter.top/v1"
wire_api = "responses"
requires_openai_auth = false
env_key = "OPENAI_API_KEY"
experimental_bearer_token = "sk-should-be-removed"
anybridge_managed = true
"#,
        )
        .unwrap();

        Platform::Codex.apply_codex_official(&path, true).unwrap();

        let raw = fs::read_to_string(&path).unwrap();
        let doc = raw.parse::<DocumentMut>().unwrap();
        let provider = doc["model_providers"][CODEX_RUNTIME_MODEL_PROVIDER_ID]
            .as_table()
            .unwrap();

        assert_eq!(
            provider.get("requires_openai_auth").and_then(|v| v.as_bool()),
            Some(true)
        );
        assert!(provider.get("experimental_bearer_token").is_none());
        assert!(provider.get("env_key").is_none());
        assert!(provider.get("auth").is_none());
        assert!(provider.get("base_url").is_none());

        let _ = fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn apply_codex_agents_preserves_user_roles_and_replaces_managed_roles() {
        let path = temp_config_path("codex-agents");
        let dir = path.parent().unwrap().join(CODEX_ANYBRIDGE_AGENTS_DIRNAME);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("old-agent.toml"), "name = \"old-agent\"\n").unwrap();
        fs::write(
            dir.join(CODEX_ANYBRIDGE_AGENTS_MANIFEST),
            r#"{
  "version": 1,
  "roles": ["old-agent"],
  "files": ["old-agent.toml"],
  "managedGlobal": {
    "max_threads": 6,
    "max_depth": 1,
    "job_max_runtime_seconds": 1800
  }
}"#,
        )
        .unwrap();
        fs::write(
            &path,
            r#"
model = "old-model"

[agents]
max_threads = 6
max_depth = 1
job_max_runtime_seconds = 1800

[agents.old-agent]
description = "old managed"
config_file = "./anybridge-agents/old-agent.toml"

[agents.manual]
description = "user managed"
config_file = "./agents/manual.toml"
"#,
        )
        .unwrap();

        let mut provider = test_openai_provider();
        provider.route_through_proxy = false;
        provider.agents_config = Some(AgentsGlobalConfig {
            max_threads: 4,
            max_depth: 1,
            job_max_runtime_seconds: 900,
        });
        provider.agents = vec![CodexAgent {
            name: "code-reviewer".to_string(),
            description: "Review code for correctness.".to_string(),
            developer_instructions: "Prioritize bugs and missing tests.".to_string(),
            model: "gpt-test".to_string(),
            model_reasoning_effort: Some("high".to_string()),
            sandbox_mode: Some("read-only".to_string()),
            nickname_candidates: vec!["Atlas".to_string()],
        }];

        Platform::Codex.apply_codex(&path, &provider).unwrap();

        let raw = fs::read_to_string(&path).unwrap();
        let doc = raw.parse::<DocumentMut>().unwrap();
        let agents = doc["agents"].as_table().unwrap();
        assert!(agents.get("old-agent").is_none());
        assert_eq!(
            agents["manual"]["config_file"].as_str(),
            Some("./agents/manual.toml")
        );
        assert_eq!(
            agents["code-reviewer"]["config_file"].as_str(),
            Some("./anybridge-agents/code-reviewer.toml")
        );
        assert_eq!(agents["max_threads"].as_integer(), Some(4));
        assert!(!dir.join("old-agent.toml").exists());
        let agent_raw = fs::read_to_string(dir.join("code-reviewer.toml")).unwrap();
        assert!(agent_raw.contains("developer_instructions"));
        assert!(agent_raw.contains("model_reasoning_effort = \"high\""));

        let _ = fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn apply_codex_agents_rejects_invalid_global_config_before_cleanup() {
        let path = temp_config_path("codex-agents-invalid-global");
        let dir = path.parent().unwrap().join(CODEX_ANYBRIDGE_AGENTS_DIRNAME);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("old-agent.toml"), "name = \"old-agent\"\n").unwrap();
        fs::write(
            dir.join(CODEX_ANYBRIDGE_AGENTS_MANIFEST),
            r#"{
  "version": 1,
  "roles": ["old-agent"],
  "files": ["old-agent.toml"],
  "managedGlobal": {
    "max_threads": 6,
    "max_depth": 1,
    "job_max_runtime_seconds": 1800
  }
}"#,
        )
        .unwrap();
        fs::write(
            &path,
            r#"
[agents]
max_threads = 6
max_depth = 1
job_max_runtime_seconds = 1800

[agents.old-agent]
description = "old managed"
config_file = "./anybridge-agents/old-agent.toml"
"#,
        )
        .unwrap();

        let mut provider = test_openai_provider();
        provider.route_through_proxy = false;
        provider.agents_config = Some(AgentsGlobalConfig {
            max_threads: 0,
            max_depth: 1,
            job_max_runtime_seconds: 900,
        });
        provider.agents = vec![CodexAgent {
            name: "code-reviewer".to_string(),
            description: "Review code for correctness.".to_string(),
            developer_instructions: "Prioritize bugs and missing tests.".to_string(),
            model: "gpt-test".to_string(),
            model_reasoning_effort: Some("high".to_string()),
            sandbox_mode: Some("read-only".to_string()),
            nickname_candidates: vec!["Atlas".to_string()],
        }];

        let err = Platform::Codex.apply_codex(&path, &provider).unwrap_err();
        assert!(err.contains("maxThreads"));
        assert!(dir.join("old-agent.toml").exists());
        let raw = fs::read_to_string(&path).unwrap();
        assert!(raw.contains("[agents.old-agent]"));

        let _ = fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn apply_codex_removes_service_tier_when_switching_to_third_party() {
        let path = temp_config_path("codex-remove-service-tier");
        fs::write(
            &path,
            r#"
model = "gpt-5.6-sol"
model_provider = "openai"
service_tier = "default"

[model_providers.openai]
name = "OpenAI"
"#,
        )
        .unwrap();

        let provider = test_openai_provider();
        Platform::Codex.apply_codex(&path, &provider).unwrap();

        let raw = fs::read_to_string(&path).unwrap();
        let doc = raw.parse::<DocumentMut>().unwrap();
        assert!(doc.get("service_tier").is_none(),
            "service_tier should be removed when switching to third-party provider");
        assert_eq!(
            doc["model_provider"].as_str(),
            Some(CODEX_RUNTIME_MODEL_PROVIDER_ID)
        );

        let _ = fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn apply_codex_direct_provider_writes_provider_api_key() {
        let path = temp_config_path("codex-direct");
        fs::write(
            &path,
            r#"
model = "old-model"

[model_providers.old]
base_url = "https://old.example.com/v1"
wire_api = "responses"
"#,
        )
        .unwrap();

        let mut provider = test_openai_provider();
        provider.route_through_proxy = false;
        Platform::Codex.apply_codex(&path, &provider).unwrap();

        let raw = fs::read_to_string(&path).unwrap();
        let doc = raw.parse::<DocumentMut>().unwrap();
        assert_eq!(
            doc["model_provider"].as_str(),
            Some(CODEX_RUNTIME_MODEL_PROVIDER_ID)
        );
        assert_eq!(
            doc["model_providers"][CODEX_RUNTIME_MODEL_PROVIDER_ID]["base_url"].as_str(),
            Some("https://example.com/v1/responses")
        );
        assert_eq!(
            doc["model_providers"][CODEX_RUNTIME_MODEL_PROVIDER_ID]["experimental_bearer_token"]
                .as_str(),
            Some("sk-test-secret")
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
    fn read_codex_config_info_marks_anybridge_local_access_as_managed() {
        let path = temp_config_path("codex-managed-local-access");
        fs::write(
            &path,
            r#"
model = "gpt-test"
model_provider = "codex_local_access"

[model_providers.codex_local_access]
name = "AnyRouter"
base_url = "https://anyrouter.top/v1"
wire_api = "responses"
experimental_bearer_token = "sk-test-secret"
anybridge_managed = true
"#,
        )
        .unwrap();

        let info = read_codex_config_info(&path).unwrap().unwrap();
        assert_eq!(
            info.model_provider_id.as_deref(),
            Some(CODEX_RUNTIME_MODEL_PROVIDER_ID)
        );
        assert_eq!(info.provider_name.as_deref(), Some("AnyRouter"));
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
    fn read_codex_config_info_unified_official_is_official() {
        let path = temp_config_path("codex-unified-official");
        fs::write(
            &path,
            r#"
model_provider = "codex_local_access"

[model_providers.codex_local_access]
name = "OpenAI 官方"
wire_api = "responses"
requires_openai_auth = true
anybridge_managed = true
"#,
        )
        .unwrap();

        let info = read_codex_config_info(&path).unwrap().unwrap();
        assert!(info.is_official);
        assert!(info.managed_by_any_bridge);
        assert_eq!(
            info.model_provider_id.as_deref(),
            Some(CODEX_RUNTIME_MODEL_PROVIDER_ID)
        );
        assert!(info.base_url.is_none());
        assert!(!info.has_bearer_token);

        let _ = fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn apply_codex_official_with_unify_keeps_codex_local_access_bucket() {
        let path = temp_config_path("codex-restore-unify-official");
        fs::write(
            &path,
            r#"
model = "third-party-model"
model_provider = "codex_local_access"

[model_providers.codex_local_access]
name = "AnyBridge"
base_url = "http://127.0.0.1:7450/v1"
wire_api = "responses"
experimental_bearer_token = "sk-test"
anybridge_managed = true
"#,
        )
        .unwrap();

        Platform::Codex.apply_codex_official(&path, true).unwrap();

        let raw = fs::read_to_string(&path).unwrap();
        let doc = raw.parse::<DocumentMut>().unwrap();
        assert!(doc.get("model").is_none());
        assert_eq!(
            doc.get("model_provider").and_then(|item| item.as_str()),
            Some(CODEX_RUNTIME_MODEL_PROVIDER_ID)
        );
        let provider = doc["model_providers"][CODEX_RUNTIME_MODEL_PROVIDER_ID]
            .as_table()
            .unwrap();
        assert_eq!(provider.get("name").and_then(|v| v.as_str()), Some("OpenAI 官方"));
        assert_eq!(
            provider.get("requires_openai_auth").and_then(|v| v.as_bool()),
            Some(true)
        );
        assert!(provider.get("base_url").is_none());
        assert!(provider.get("experimental_bearer_token").is_none());
        assert_eq!(
            provider
                .get(CODEX_ANYBRIDGE_MANAGED_FLAG)
                .and_then(|v| v.as_bool()),
            Some(true)
        );

        let info = read_codex_config_info(&path).unwrap().unwrap();
        assert!(info.is_official);
        assert!(info.managed_by_any_bridge);

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

        Platform::Codex.apply_codex_official(&path, false).unwrap();

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

    #[test]
    fn apply_codex_official_removes_anybridge_managed_local_access() {
        let path = temp_config_path("codex-restore-managed-local-access");
        fs::write(
            &path,
            r#"
model = "third-party-model"
model_provider = "codex_local_access"

[mcp_servers.docs]
command = "node"

[model_providers.codex_local_access]
name = "AnyBridge"
base_url = "http://127.0.0.1:7450/v1"
wire_api = "responses"
experimental_bearer_token = "sk-test"
anybridge_managed = true

[model_providers.manual]
name = "Manual"
base_url = "https://manual.example.com/v1"
wire_api = "responses"
"#,
        )
        .unwrap();

        Platform::Codex.apply_codex_official(&path, false).unwrap();

        let raw = fs::read_to_string(&path).unwrap();
        let doc = raw.parse::<DocumentMut>().unwrap();
        assert!(doc.get("model").is_none());
        assert!(doc.get("model_provider").is_none());
        assert!(doc["model_providers"]
            .as_table()
            .unwrap()
            .get(CODEX_RUNTIME_MODEL_PROVIDER_ID)
            .is_none());
        assert_eq!(
            doc["model_providers"]["manual"]["base_url"].as_str(),
            Some("https://manual.example.com/v1")
        );
        assert_eq!(doc["mcp_servers"]["docs"]["command"].as_str(), Some("node"));

        let _ = fs::remove_dir_all(path.parent().unwrap());
    }
}
