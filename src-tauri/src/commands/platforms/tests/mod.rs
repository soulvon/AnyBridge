#[allow(unused_imports)]
pub(super) use super::*;
#[allow(unused_imports)]
pub(super) use crate::commands::config::{
    AgentsGlobalConfig, ApiFormat, ClaudeCodeConfig, CodexAgent, CodexConfig, OpenCodeConfig,
    Provider, ProviderCapabilities, ProviderStore, ProviderUnlocks,
};
#[allow(unused_imports)]
pub(super) use serde_json::Map;
#[allow(unused_imports)]
pub(super) use std::collections::{HashMap, HashSet};
#[allow(unused_imports)]
pub(super) use std::fs;
#[allow(unused_imports)]
pub(super) use std::path::{Path, PathBuf};
#[allow(unused_imports)]
pub(super) use std::time::{SystemTime, UNIX_EPOCH};
#[allow(unused_imports)]
pub(super) use toml_edit::{DocumentMut, Item};

pub(super) fn temp_config_path(name: &str) -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let dir = std::env::temp_dir().join(format!("anybridge-{name}-{nanos}"));
    fs::create_dir_all(&dir).unwrap();
    dir.join("config.toml")
}


/// 把补丁结果交给 Node 真解析。node 起不来/临时文件写不进去必须报错，
/// 绝不静默跳过——静默通过等于把执行级校验降级成摆设（35ef9897 政策：
/// verify 全链本就依赖 node，不存在「缺 node 的 CI」，老注释已作废）。
/// 全量并发/打包高负载下 spawn 偶发抖动，失败重试。
pub(super) fn assert_valid_js(label: &str, code: &str) {
    let tmp = std::env::temp_dir().join(format!(
        "anybridge-ag-patch-{}-{}-{}.js",
        std::process::id(),
        label.replace(|c: char| !c.is_ascii_alphanumeric(), "_"),
        SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()
    ));
    let mut last_fail: Option<String> = None;
    for _attempt in 0..3 {
        if let Err(e) = fs::write(&tmp, code) {
            last_fail = Some(format!("测试脚本落盘失败（临时文件 {}）: {e}", tmp.display()));
            continue;
        }
        match std::process::Command::new("node")
            .env_remove("NODE_OPTIONS")
            .arg("--check")
            .arg(&tmp)
            .output()
        {
            Err(e) => last_fail = Some(format!("node 无法启动: {e}")),
            Ok(out) if out.status.success() => {
                last_fail = None;
                break;
            }
            Ok(out) => {
                last_fail = Some(format!(
                    "{label} 注入后的 JS 必须能被 Node 解析: {}",
                    String::from_utf8_lossy(&out.stderr)
                ));
            }
        }
    }
    if let Some(msg) = last_fail {
        panic!("{msg}（重试 3 次）");
    }
    let _ = fs::remove_file(&tmp);
}


pub(super) fn isolated_node_cmd(home: &std::path::Path) -> std::process::Command {
    let mut cmd = std::process::Command::new("node");
    cmd.env_remove("NODE_OPTIONS")
        .env_remove("ANYBRIDGE_ANTIGRAVITY_SETTINGS")
        .env("USERPROFILE", home)
        .env("HOME", home)
        .env("APPDATA", home)
        .env("LOCALAPPDATA", home)
        .env("XDG_CONFIG_HOME", home)
        .env("XDG_DATA_HOME", home);
    cmd
}


pub(super) fn temp_json_path(name: &str) -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let dir = std::env::temp_dir().join(format!("anybridge-{name}-{nanos}"));
    fs::create_dir_all(&dir).unwrap();
    dir.join("settings.json")
}


pub(super) fn models_json_obj(raw: &str) -> Map<String, Value> {
    let value: Value = serde_json::from_str(raw).unwrap();
    value.as_object().cloned().unwrap()
}


pub(super) fn test_openai_provider() -> Provider {
    Provider {
        id: "provider-1".to_string(),
        name: "Test Provider".to_string(),
        api_host: "https://example.com".to_string(),
        api_key: "sk-test-secret".to_string(),
        api_keys: Vec::new(),
        api_path: Some("/v1/responses".to_string()),
        default_model: "gpt-test".to_string(),
        api_format: Some(ApiFormat::Openai),
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
        context_window: None,
        model_contexts: HashMap::new(),
        subagent_models: HashMap::new(),
    }
}


pub(super) fn test_claude_provider() -> Provider {
    Provider {
        id: "claude-provider-1".to_string(),
        name: "Claude Test Provider".to_string(),
        api_host: "https://anthropic.example.com".to_string(),
        api_key: "sk-ant-test-secret".to_string(),
        api_keys: Vec::new(),
        api_path: None,
        default_model: "claude-test-model".to_string(),
        api_format: Some(ApiFormat::Anthropic),
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
        context_window: None,
        model_contexts: HashMap::new(),
        subagent_models: HashMap::new(),
    }
}


// ─── 字段级记账与还原（配置切换重构 2026-10-26） ─────────────

pub(super) fn field_restore_tmp(name: &str) -> (PathBuf, PathBuf) {
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
    let dir = std::env::temp_dir().join(format!("anybridge-fieldrestore-{name}-{nanos}"));
    fs::create_dir_all(&dir).unwrap();
    (dir.join("settings.json"), dir.join("stash"))
}


const FIELD_RESTORE_ORIGINAL: &str = r#"{
  "env": {
"ANTHROPIC_BASE_URL": "https://corp.example",
"ANTHROPIC_AUTH_TOKEN": "sk-user-original",
"ANTHROPIC_SMALL_FAST_MODEL": "claude-haiku-old"
  },
  "permissions": { "allow": ["Read"] }
}"#;


// ─── 保形写入门控（ANYBRIDGE_FORMAT_PRESERVING_JSON） ─────────

use std::sync::Mutex as StdMutex;

static PRESERVING_ENV_LOCK: StdMutex<()> = StdMutex::new(());


/// 统一门控 helper：一把锁内设置任意组合的门控 env（进程级全局，
/// 测试必须互斥）。None = 不动该门控。**严禁嵌套调用**（std Mutex
/// 不可重入，套两层会死锁——曾把 opencode_preserving 测试挂死 60s+）。
pub(super) fn with_gates<T>(
    preserving: Option<bool>,
    field_restore: Option<bool>,
    f: impl FnOnce() -> T,
) -> T {
    let _g = PRESERVING_ENV_LOCK
        .lock()
        .unwrap_or_else(|p| p.into_inner());
    let set = |key: &str, v: Option<bool>| match v {
        Some(true) => std::env::set_var(key, "1"),
        Some(false) => std::env::set_var(key, "0"),
        None => {}
    };
    set("ANYBRIDGE_FORMAT_PRESERVING_JSON", preserving);
    set("ANYBRIDGE_FIELD_RESTORE", field_restore);
    let out = f();
    std::env::remove_var("ANYBRIDGE_FORMAT_PRESERVING_JSON");
    std::env::remove_var("ANYBRIDGE_FIELD_RESTORE");
    out
}


/// 串行化设置保形门控 env（进程级全局，测试必须互斥）。
pub(super) fn with_preserving_json<T>(enabled: bool, f: impl FnOnce() -> T) -> T {
    with_gates(Some(enabled), None, f)
}


const PRESERVING_ORIGINAL: &str = r#"{
  // 我的注释：手动维护
  "env": {
"ANTHROPIC_BASE_URL": "https://corp.example",
"CUSTOM": "keep"
  }
}"#;


// ─── Codex 记账 + 字段级还原 ────────────────────────────────

/// 临时目录版（config.toml + stash 子目录），不碰真实配置。
pub(super) fn field_restore_tmp_toml(name: &str) -> (PathBuf, PathBuf) {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let dir = std::env::temp_dir().join(format!("anybridge-codexfr-{name}-{nanos}"));
    fs::create_dir_all(&dir).unwrap();
    (dir.join("config.toml"), dir.join("stash"))
}


const CODEX_USER_ORIGINAL: &str = r#"model = "my-model"
model_provider = "my-provider"
service_tier = "pro"

[model_providers.my-provider]
name = "My Provider"
base_url = "https://my.example.com/v1"
"#;


pub(super) fn test_store_with_chat_source(config: crate::commands::config::CodexConfig) -> ProviderStore {
    let mut source = test_openai_provider();
    source.id = "prov-chat".to_string();
    source.api_path = Some("/v1/chat/completions".to_string());
    ProviderStore {
        providers: vec![source],
        codex_configs: vec![config],
        ..Default::default()
    }
}


// ─── OpenCode 记账 + 字段级还原 ─────────────────────────────

pub(super) fn with_field_restore<T>(enabled: bool, f: impl FnOnce() -> T) -> T {
    with_gates(None, Some(enabled), f)
}


const OPENCODE_ORIGINAL: &str = r#"{
  "$schema": "https://opencode.ai/config.json",
  "model": "user-own/gpt-x",
  "provider": {
"user-own": {
  "npm": "@ai-sdk/openai-compatible",
  "name": "User Own"
}
  }
}"#;


// ─── ZCode / Grok / Buddy / Antigravity / Pi 记账+还原 ────────

pub(super) fn named_tmp_config(name: &str, file: &str) -> (PathBuf, PathBuf) {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let dir = std::env::temp_dir().join(format!("anybridge-{name}-{nanos}"));
    fs::create_dir_all(&dir).unwrap();
    (dir.join(file), dir.join("stash"))
}


// ─── Hermes Agent / DeepSeek Harness ────────────────────────

pub(super) fn temp_managed_dir(name: &str) -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let dir = std::env::temp_dir().join(format!("anybridge-managed-{name}-{nanos}"));
    fs::create_dir_all(&dir).unwrap();
    dir
}


mod antigravity_patch;
mod antigravity_settings;
mod zcode_buddy;
mod codex;
mod claude_field;
mod codex_field;
mod grok_opencode;
mod pi;
mod yaml_platforms;
mod ssot_and_restore;
