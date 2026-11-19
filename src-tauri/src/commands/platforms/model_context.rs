

/// 主流模型推荐上下文配置（与 ui/assets/model-context-presets.json 对齐）。
/// 编译期嵌入 JSON，避免运行时路径/CWD 依赖与双份漂移。
#[derive(Debug, Clone, serde::Deserialize)]
pub(in crate::commands::platforms) struct ModelContextDefaults {
    #[serde(rename = "maxInputTokens", default = "default_max_input")]
    pub(in crate::commands::platforms) max_input_tokens: u64,
    #[serde(rename = "maxOutputTokens", default = "default_max_output")]
    pub(in crate::commands::platforms) max_output_tokens: u64,
}


pub(in crate::commands::platforms) fn default_max_input() -> u64 {
    256_000
}

pub(in crate::commands::platforms) fn default_max_output() -> u64 {
    16_384
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
pub(in crate::commands::platforms) struct ModelContextModelEntry {
    pub(in crate::commands::platforms) id: Option<String>,
    #[serde(rename = "match")]
    pub(in crate::commands::platforms) match_field: Option<Vec<String>>,
    #[serde(rename = "maxInputTokens")]
    pub(in crate::commands::platforms) max_input_tokens: Option<u64>,
    #[serde(rename = "maxOutputTokens")]
    pub(in crate::commands::platforms) max_output_tokens: Option<u64>,
}


#[derive(Debug, Clone, serde::Deserialize)]
pub(in crate::commands::platforms) struct ModelContextPatternEntry {
    #[allow(dead_code)]
    pub(in crate::commands::platforms) id: Option<String>,
    #[serde(rename = "includesAny")]
    pub(in crate::commands::platforms) includes_any: Option<Vec<String>>,
    #[serde(rename = "requiresAny")]
    pub(in crate::commands::platforms) requires_any: Option<Vec<String>>,
    #[serde(rename = "maxInputTokens")]
    pub(in crate::commands::platforms) max_input_tokens: Option<u64>,
    #[serde(rename = "maxOutputTokens")]
    pub(in crate::commands::platforms) max_output_tokens: Option<u64>,
}


#[derive(Debug, Clone, serde::Deserialize, Default)]
pub(in crate::commands::platforms) struct ModelContextPresets {
    #[serde(default)]
    pub(in crate::commands::platforms) defaults: ModelContextDefaults,
    #[serde(default)]
    pub(in crate::commands::platforms) models: Vec<ModelContextModelEntry>,
    #[serde(default)]
    pub(in crate::commands::platforms) patterns: Vec<ModelContextPatternEntry>,
}


pub(in crate::commands::platforms) const MODEL_CONTEXT_PRESETS_JSON: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../ui/assets/model-context-presets.json"
));


pub(in crate::commands::platforms) fn load_model_context_presets() -> ModelContextPresets {
    match serde_json::from_str::<ModelContextPresets>(MODEL_CONTEXT_PRESETS_JSON) {
        Ok(parsed) => parsed,
        Err(err) => {
            eprintln!("[model-context-presets] 内置 JSON 解析失败，回退默认值: {err}");
            ModelContextPresets::default()
        }
    }
}


pub(in crate::commands::platforms) fn model_context_presets() -> &'static ModelContextPresets {
    use std::sync::OnceLock;
    static PRESETS: OnceLock<ModelContextPresets> = OnceLock::new();
    PRESETS.get_or_init(load_model_context_presets)
}


pub(in crate::commands::platforms) fn normalize_model_id(model_id: &str) -> String {
    model_id
        .to_ascii_lowercase()
        .chars()
        .map(|c| if c.is_whitespace() { '-' } else { c })
        .collect()
}


/// 短 token / 版本碎片：只允许精确或前缀匹配，避免 o1、m2.7、seed 误伤。
pub(in crate::commands::platforms) fn is_ambiguous_token(token: &str) -> bool {
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


pub(in crate::commands::platforms) fn is_boundary_char(c: char) -> bool {
    !c.is_ascii_alphanumeric()
}


/// 边界匹配：token 必须是完整片段（两侧为非字母数字或边界）。
pub(in crate::commands::platforms) fn token_matches(id: &str, token: &str) -> bool {
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


pub(in crate::commands::platforms) fn list_hit(id: &str, list: &[String]) -> bool {
    list.iter().any(|token| token_matches(id, token))
}


pub(in crate::commands::platforms) fn score_match(id: &str, token: &str) -> i32 {
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


pub(in crate::commands::platforms) fn resolve_model_context_preset(model_id: &str) -> (u64, u64) {
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
                best_out = entry
                    .max_output_tokens
                    .unwrap_or(defaults.max_output_tokens);
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
            entry
                .max_output_tokens
                .unwrap_or(defaults.max_output_tokens),
        );
    }

    (defaults.max_input_tokens, defaults.max_output_tokens)
}


/// 按模型 ID 推断推荐上下文窗口（优先读 model-context-presets.json）。
pub(in crate::commands::platforms) fn recommend_context_window(model_id: &str) -> u64 {
    resolve_model_context_preset(model_id).0
}


pub(in crate::commands::platforms) fn recommend_max_output_tokens(model_id: &str) -> u64 {
    resolve_model_context_preset(model_id).1
}
