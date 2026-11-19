use std::collections::HashMap;
use crate::commands::google_gemini;
use super::types::*;

fn parse_api_format_tag(raw: &str) -> Option<ApiFormat> {
    match raw.trim().to_ascii_lowercase().as_str() {
        "anthropic" => Some(ApiFormat::Anthropic),
        "gemini" => Some(ApiFormat::Gemini),
        "openai" => Some(ApiFormat::Openai),
        _ => None,
    }
}

/// 从供应商的 API 路径推断 Codex 上游协议；返回 None 表示路径未携带端点信息。
pub(crate) fn infer_wire_api_from_api_path(api_path: Option<&str>) -> Option<&'static str> {
    let path = api_path?.trim().trim_end_matches('/').to_ascii_lowercase();
    if path.ends_with("/chat/completions") {
        Some("chat")
    } else if path.ends_with("/responses") {
        Some("responses")
    } else {
        None
    }
}

fn find_source_provider<'a>(
    source_provider_id: &str,
    providers: &'a [Provider],
) -> Option<&'a Provider> {
    let id = source_provider_id.trim();
    if id.is_empty() {
        return None;
    }
    providers.iter().find(|p| p.id == id)
}

fn validate_source_binding(
    config_name: &str,
    source_provider_id: &str,
    providers: &[Provider],
) -> Result<(), String> {
    let source_id = source_provider_id.trim();
    if source_id.is_empty() {
        return Ok(());
    }
    let src = providers.iter().find(|p| p.id == source_id).ok_or_else(|| {
        format!("配置「{config_name}」绑定的主供应商不存在（{source_id}）")
    })?;
    if !src.enabled {
        return Err(format!(
            "配置「{config_name}」绑定的主供应商「{}」已禁用",
            src.name
        ));
    }
    Ok(())
}

/// 将主供应商的实时字段（主机、路径、主密钥与密钥池、启用态、能力、解锁项、协议格式）
/// 同步到衍生 `Provider`。
/// 只要 `source_provider_id` 非空但找不到对应主供应商，必须显式置 `enabled = false`（绝不静默回退旧快照）。
fn apply_live_source_fields<'a>(
    target: &mut Provider,
    source_provider_id: &str,
    providers: &'a [Provider],
    override_api_format: Option<&str>,
    fallback_api_format: Option<ApiFormat>,
) -> Option<&'a Provider> {
    let trimmed = source_provider_id.trim();
    if trimmed.is_empty() {
        if google_gemini::is_official_google_gemini_native_only_endpoint(
            &target.api_host,
            target.api_path.as_deref(),
        ) {
            target.api_format = Some(ApiFormat::Gemini);
        } else if let Some(ov) = override_api_format.and_then(parse_api_format_tag) {
            target.api_format = Some(ov);
        }
        return None;
    }

    let Some(src) = providers.iter().find(|p| p.id == trimmed) else {
        target.enabled = false;
        return None;
    };

    target.api_host = src.api_host.clone();
    target.api_path = src.api_path.clone();
    target.api_key = src.api_key.clone();
    target.api_keys = src.api_keys.clone();
    target.enabled = src.enabled;
    target.capabilities = src.capabilities.clone();
    target.model_caps = src.model_caps.clone();
    target.unlocks = src.unlocks.clone();

    if google_gemini::is_official_google_gemini_native_only_endpoint(
        &target.api_host,
        target.api_path.as_deref(),
    ) {
        target.api_format = Some(ApiFormat::Gemini);
    } else if let Some(ov) = override_api_format.and_then(parse_api_format_tag) {
        target.api_format = Some(ov);
    } else if let Some(fmt) = src.api_format {
        target.api_format = Some(fmt);
    } else if let Some(inferred) = google_gemini::infer_api_format_from_endpoint(
        &target.api_host,
        target.api_path.as_deref(),
    )
    .and_then(parse_api_format_tag)
    {
        target.api_format = Some(inferred);
    } else if let Some(fb) = fallback_api_format {
        target.api_format = Some(fb);
    }

    Some(src)
}

impl AntigravityConfig {
    pub fn resolved_api_format_with_source(&self, source: Option<&Provider>) -> ApiFormat {
        let host = source.map(|p| p.api_host.as_str()).unwrap_or(&self.api_host);
        let path = source
            .map(|p| p.api_path.as_deref())
            .unwrap_or(self.api_path.as_deref());
        if google_gemini::is_official_google_gemini_native_only_endpoint(host, path) {
            return ApiFormat::Gemini;
        }
        if let Some(ov) = self
            .api_format_override
            .as_deref()
            .and_then(parse_api_format_tag)
        {
            return ov;
        }
        if let Some(src) = source {
            if let Some(fmt) = src.api_format {
                return fmt;
            }
            if let Some(fmt) = google_gemini::infer_api_format_from_endpoint(host, path)
                .and_then(parse_api_format_tag)
            {
                return fmt;
            }
            return parse_api_format_tag(&self.api_format).unwrap_or(ApiFormat::Openai);
        }
        parse_api_format_tag(&self.api_format)
            .or_else(|| {
                google_gemini::infer_api_format_from_endpoint(host, path)
                    .and_then(parse_api_format_tag)
            })
            .unwrap_or(ApiFormat::Openai)
    }

    pub fn resolved_api_format(&self) -> ApiFormat {
        self.resolved_api_format_with_source(None)
    }

    pub fn validate_active_source(&self, providers: &[Provider]) -> Result<(), String> {
        validate_source_binding(&self.name, &self.source_provider_id, providers)
    }

    pub fn resolve_provider(&self, providers: &[Provider]) -> Provider {
        let source = find_source_provider(&self.source_provider_id, providers);
        let fmt = self.resolved_api_format_with_source(source);
        let mut p = Provider::from(self.clone());
        if let Some(src) = apply_live_source_fields(
            &mut p,
            &self.source_provider_id,
            providers,
            self.api_format_override.as_deref(),
            Some(fmt),
        ) {
            if !src.wire_api.trim().is_empty() {
                p.wire_api = src.wire_api.clone();
            }
        }
        p.api_format = Some(fmt);
        p
    }
}

impl CodexConfig {
    pub fn validate_active_source(&self, providers: &[Provider]) -> Result<(), String> {
        validate_source_binding(&self.name, &self.source_provider_id, providers)
    }

    pub fn resolve_provider(&self, providers: &[Provider]) -> Provider {
        let mut p = Provider::from(self.clone());
        if let Some(src) = apply_live_source_fields(
            &mut p,
            &self.source_provider_id,
            providers,
            None,
            Some(ApiFormat::Openai),
        ) {
            if self.wire_api_auto {
                let explicit = src.wire_api.trim().to_ascii_lowercase();
                if explicit == "chat" || explicit == "responses" {
                    p.wire_api = explicit;
                } else if let Some(inferred) =
                    infer_wire_api_from_api_path(src.api_path.as_deref())
                {
                    p.wire_api = inferred.to_string();
                }
            }
        }
        p
    }
}

impl ClaudeCodeConfig {
    pub fn validate_active_source(&self, providers: &[Provider]) -> Result<(), String> {
        validate_source_binding(&self.name, &self.source_provider_id, providers)
    }

    pub fn resolve_provider(&self, providers: &[Provider]) -> Provider {
        let mut p = Provider::from(self.clone());
        apply_live_source_fields(
            &mut p,
            &self.source_provider_id,
            providers,
            None,
            Some(ApiFormat::Anthropic),
        );
        p
    }
}

impl OpenCodeConfig {
    pub fn validate_active_source(&self, providers: &[Provider]) -> Result<(), String> {
        validate_source_binding(&self.name, &self.source_provider_id, providers)
    }

    pub fn resolve_provider(&self, providers: &[Provider]) -> Provider {
        let mut p = Provider::from(self.clone());
        apply_live_source_fields(
            &mut p,
            &self.source_provider_id,
            providers,
            None,
            Some(ApiFormat::Openai),
        );
        p
    }
}

impl GrokConfig {
    pub fn validate_active_source(&self, providers: &[Provider]) -> Result<(), String> {
        validate_source_binding(&self.name, &self.source_provider_id, providers)
    }

    pub fn resolve_provider(&self, providers: &[Provider]) -> Provider {
        let mut p = Provider::from(self.clone());
        apply_live_source_fields(
            &mut p,
            &self.source_provider_id,
            providers,
            None,
            Some(ApiFormat::Openai),
        );
        p
    }
}

impl ClaudeDesktopConfig {
    pub fn validate_active_source(&self, providers: &[Provider]) -> Result<(), String> {
        validate_source_binding(&self.name, &self.source_provider_id, providers)
    }

    pub fn resolve_provider(&self, providers: &[Provider]) -> Provider {
        let mut p = Provider::from(self.clone());
        apply_live_source_fields(
            &mut p,
            &self.source_provider_id,
            providers,
            None,
            Some(ApiFormat::Anthropic),
        );
        p
    }
}

impl From<ClaudeDesktopConfig> for Provider {
    fn from(config: ClaudeDesktopConfig) -> Self {
        let mut models = Vec::new();
        for m in [
            config.sonnet_model.trim(),
            config.opus_model.trim(),
            config.haiku_model.trim(),
            config.fable_model.trim(),
        ] {
            if !m.is_empty() && !models.iter().any(|existing| existing == m) {
                models.push(m.to_string());
            }
        }
        let default_model = models.first().cloned().unwrap_or_default();
        Provider {
            id: config.id,
            name: config.name,
            api_host: config.api_host,
            api_key: config.api_key,
            api_keys: Vec::new(),
            api_path: config.api_path,
            default_model,
            api_format: Some(ApiFormat::Anthropic),
            enabled: true,
            models,
            capabilities: ProviderCapabilities {
                text: true,
                stream: true,
                ..ProviderCapabilities::default()
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
}

impl From<AntigravityConfig> for Provider {
    fn from(config: AntigravityConfig) -> Self {
        let fmt = config.resolved_api_format();
        Provider {
            id: config.id,
            name: config.name,
            api_host: config.api_host,
            api_key: config.api_key,
            api_keys: Vec::new(),
            api_path: config.api_path,
            default_model: config.default_model,
            api_format: Some(fmt),
            enabled: true,
            models: config.models,
            capabilities: ProviderCapabilities {
                text: true,
                stream: true,
                ..ProviderCapabilities::default()
            },
            model_caps: HashMap::new(),
            unlocks: ProviderUnlocks::default(),
            wire_api: String::new(),
            route_through_proxy: true,
            inject_models: config.inject_models,
            preserve_official_auth: false,
            unify_session_history: false,
            model_catalog: config.model_catalog,
            codex_chat_reasoning: None,
            agents_config: None,
            agents: Vec::new(),
            context_window: None,
            model_contexts: HashMap::new(),
            subagent_models: HashMap::new(),
        }
    }
}

impl From<CodexConfig> for Provider {
    fn from(config: CodexConfig) -> Self {
        Provider {
            id: config.id,
            name: config.name,
            api_host: config.api_host,
            api_key: config.api_key,
            api_keys: Vec::new(),
            api_path: config.api_path,
            default_model: config.default_model,
            api_format: Some(ApiFormat::Openai),
            enabled: true,
            models: config.models,
            capabilities: ProviderCapabilities {
                text: true,
                stream: true,
                ..ProviderCapabilities::default()
            },
            model_caps: HashMap::new(),
            unlocks: ProviderUnlocks::default(),
            wire_api: config.wire_api,
            route_through_proxy: config.route_through_proxy,
            inject_models: config.inject_models,
            preserve_official_auth: config.preserve_official_auth,
            unify_session_history: config.unify_session_history,
            model_catalog: config.model_catalog,
            codex_chat_reasoning: config.codex_chat_reasoning,
            agents_config: config.agents_config,
            agents: config.agents,
            context_window: None,
            model_contexts: HashMap::new(),
            subagent_models: HashMap::new(),
        }
    }
}

impl From<OpenCodeConfig> for Provider {
    fn from(config: OpenCodeConfig) -> Self {
        Provider {
            id: config.id,
            name: config.name,
            api_host: config.api_host,
            api_key: config.api_key,
            api_keys: Vec::new(),
            api_path: config.api_path,
            default_model: config.default_model,
            api_format: Some(ApiFormat::Openai),
            enabled: true,
            models: config.models,
            capabilities: ProviderCapabilities {
                text: true,
                stream: true,
                ..ProviderCapabilities::default()
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
}

impl From<GrokConfig> for Provider {
    fn from(config: GrokConfig) -> Self {
        Provider {
            id: config.id,
            name: config.name,
            api_host: config.api_host,
            api_key: config.api_key,
            api_keys: Vec::new(),
            api_path: config.api_path,
            default_model: config.default_model,
            api_format: Some(ApiFormat::Openai),
            enabled: true,
            models: config.models,
            capabilities: ProviderCapabilities {
                text: true,
                stream: true,
                ..ProviderCapabilities::default()
            },
            model_caps: HashMap::new(),
            unlocks: ProviderUnlocks::default(),
            wire_api: config.api_backend,
            route_through_proxy: true,
            inject_models: true,
            preserve_official_auth: false,
            unify_session_history: true,
            model_catalog: Vec::new(),
            codex_chat_reasoning: None,
            agents_config: None,
            agents: Vec::new(),
            context_window: config.context_window,
            model_contexts: config.model_contexts,
            subagent_models: config.subagent_models,
        }
    }
}

impl From<ClaudeCodeConfig> for Provider {
    fn from(config: ClaudeCodeConfig) -> Self {
        Provider {
            id: config.id,
            name: config.name,
            api_host: config.api_host,
            api_key: config.api_key,
            api_keys: Vec::new(),
            api_path: config.api_path,
            default_model: config.default_model,
            api_format: Some(ApiFormat::Anthropic),
            enabled: true,
            models: config.models,
            capabilities: ProviderCapabilities {
                text: true,
                stream: true,
                ..ProviderCapabilities::default()
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
}

impl Provider {
    pub fn resolved_api_format(&self) -> ApiFormat {
        if let Some(fmt) = self.api_format {
            return fmt;
        }
        match google_gemini::infer_api_format_from_endpoint(
            &self.api_host,
            self.api_path.as_deref(),
        ) {
            Some("gemini") => ApiFormat::Gemini,
            Some("anthropic") => ApiFormat::Anthropic,
            Some("openai") => ApiFormat::Openai,
            _ => {
                let mut candidates = Vec::with_capacity(self.models.len() + 1);
                candidates.push(self.default_model.as_str());
                for m in &self.models {
                    candidates.push(m.as_str());
                }
                if candidates.iter().any(|m| m.to_ascii_lowercase().contains("gemini")) {
                    ApiFormat::Gemini
                } else if candidates.iter().any(|m| m.to_ascii_lowercase().contains("claude")) {
                    ApiFormat::Anthropic
                } else {
                    ApiFormat::Openai
                }
            }
        }
    }

    pub fn resolved_api_format_str(&self) -> &'static str {
        match self.resolved_api_format() {
            ApiFormat::Openai => "openai",
            ApiFormat::Anthropic => "anthropic",
            ApiFormat::Gemini => "gemini",
        }
    }
}

