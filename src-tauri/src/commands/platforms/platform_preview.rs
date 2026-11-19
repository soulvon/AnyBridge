use crate::commands::config::Provider;

use super::buddy::buddy_model_entry;
use super::claude::claude_base_url;
use super::codex::{
    codex_base_url, codex_direct_base_url, codex_provider_bearer, CODEX_ANYBRIDGE_MANAGED_FLAG,
    CODEX_RUNTIME_MODEL_PROVIDER_ID,
};
use super::codex_catalog::{resolve_codex_model_catalog_entries, CODEX_MODEL_CATALOG_FILENAME};
use super::common::{mask_key, openai_base_url, toml_escape};
use super::deepseek_harness::harness_preview_value;
use super::grok::{grok_model_context, grok_sanitize_key};
use super::hermes::hermes_preview_value;
use super::opencode::opencode_preview;
use super::pi::{pi_entries_from_provider, pi_preview_value};
use super::platform_enum::Platform;
use super::zcode::zcode_preview;

impl Platform {

    /// 生成将写入的配置片段（预览用，token 脱敏），不落盘。
    pub(in crate::commands::platforms) fn preview(&self, p: &Provider) -> Result<String, String> {
        match self {
            Platform::Antigravity | Platform::AntigravityIde => {
                let ports = crate::commands::config::configured_proxy_ports();
                let preview = serde_json::json!({
                    "jetski.cloudCodeUrl": format!("https://localhost:{}", ports.antigravity_https_port),
                    "// 说明": format!("已接管 {}，当前绑定模型：{}", self.display_name(), p.default_model)
                });
                serde_json::to_string_pretty(&preview).map_err(|e| e.to_string())
            }
            Platform::ClaudeDesktop => crate::commands::claude_desktop::preview_claude_desktop(None),
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
                // 与 apply_codex 共用归一逻辑：预览显示的地址必须等于实际写入的地址。
                let base = if p.route_through_proxy {
                    codex_base_url()
                } else {
                    codex_direct_base_url(p)
                };
                let model = toml_escape(p.default_model.trim());
                // 预览不因缺少凭证而失败：拿不到就留空掩码。
                let bearer_for_preview = codex_provider_bearer(p)
                    .unwrap_or_default()
                    .unwrap_or_default();
                let masked = mask_key(&bearer_for_preview);
                let name = toml_escape(&p.name);
                // wire_api 恒为 "responses"，理由见 apply_codex。
                let catalog_line = if !resolve_codex_model_catalog_entries(p).is_empty() {
                    format!("\nmodel_catalog_json = \"{CODEX_MODEL_CATALOG_FILENAME}\"")
                } else {
                    String::new()
                };
                let auth_line = if p.preserve_official_auth {
                    "requires_openai_auth = true".to_string()
                } else {
                    format!(
                        "requires_openai_auth = false\nexperimental_bearer_token = \"{masked}\""
                    )
                };
                Ok(format!(
                    "model = \"{model}\"\nmodel_provider = \"{CODEX_RUNTIME_MODEL_PROVIDER_ID}\"{catalog_line}\n\n[model_providers.{CODEX_RUNTIME_MODEL_PROVIDER_ID}]\nname = \"{name}\"\nbase_url = \"{base}\"\nwire_api = \"responses\"\n{auth_line}\n{CODEX_ANYBRIDGE_MANAGED_FLAG} = true"
                ))
            }
            Platform::CodeBuddy => {
                let preview_model = buddy_model_entry(p, &mask_key(&p.api_key), false);
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
                let preview_model = buddy_model_entry(p, &mask_key(&p.api_key), true);
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
            Platform::Grok => {
                let base = openai_base_url(p);
                let raw_model = p.default_model.trim();
                let model_id = if raw_model.is_empty() {
                    "default"
                } else {
                    raw_model
                };
                let model = toml_escape(model_id);
                let masked = mask_key(&p.api_key);
                let name = toml_escape(&format!("{} · {}", p.name, model_id));
                let key = grok_sanitize_key(&p.id);
                let backend = if !p.wire_api.trim().is_empty() {
                    p.wire_api.trim()
                } else {
                    "chat_completions"
                };
                let context_line = match grok_model_context(p, model_id) {
                    Some(ctx) => format!("\ncontext_window = {ctx}"),
                    None => String::new(),
                };
                let mut out = format!(
                    "[models]\ndefault = \"{key}\"\n\n[model.{key}]\nname = \"{name}\"\nmodel = \"{model}\"\nbase_url = \"{base}\"\napi_key = \"{masked}\"\napi_backend = \"{backend}\"{context_line}\nanybridge_managed = true"
                );
                for extra in p.models.iter() {
                    let id = extra.trim();
                    if id.is_empty() || id == model_id {
                        continue;
                    }
                    let extra_key = format!("{key}--{}", grok_sanitize_key(id));
                    let extra_name = toml_escape(&format!("{} · {}", p.name, id));
                    let extra_model = toml_escape(id);
                    let extra_ctx = match grok_model_context(p, id) {
                        Some(ctx) => format!("\ncontext_window = {ctx}"),
                        None => String::new(),
                    };
                    out.push_str(&format!(
                        "\n\n[model.{extra_key}]\nname = \"{extra_name}\"\nmodel = \"{extra_model}\"\nbase_url = \"{base}\"\napi_key = \"{masked}\"\napi_backend = \"{backend}\"{extra_ctx}\nanybridge_managed = true"
                    ));
                }
                if !p.subagent_models.is_empty() {
                    let mut agents: Vec<(&String, &String)> = p.subagent_models.iter().collect();
                    agents.sort_by(|a, b| a.0.cmp(b.0));
                    let mut lines = String::new();
                    for (agent, model_key) in agents {
                        let name = agent.trim();
                        let target = model_key.trim();
                        if name.is_empty() || target.is_empty() {
                            continue;
                        }
                        lines.push_str(&format!("\n{} = \"{}\"", name, toml_escape(target)));
                    }
                    if !lines.is_empty() {
                        out.push_str(&format!("\n\n[subagents.models]{lines}"));
                    }
                }
                Ok(out)
            }
            Platform::Pi => {
                let entries = pi_entries_from_provider(p);
                let preview = pi_preview_value(&entries)?;
                serde_json::to_string_pretty(&preview).map_err(|e| e.to_string())
            }
            Platform::Hermes => {
                let entries = pi_entries_from_provider(p);
                let preview = hermes_preview_value(&entries)?;
                serde_yaml::to_string(&preview).map_err(|e| e.to_string())
            }
            Platform::DeepSeekHarness => {
                let entries = pi_entries_from_provider(p);
                let preview = harness_preview_value(&entries)?;
                serde_yaml::to_string(&preview).map_err(|e| e.to_string())
            }
        }
    }

}
