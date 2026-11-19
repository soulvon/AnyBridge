use crate::commands::config::Provider;
use serde_json::{Map, Value};
use std::fs;
use std::path::{Path, PathBuf};

use super::common::{
    agent_stash_dir, parse_json_object, provider_endpoint_url, split_url_origin_path,
    strip_first_matching_suffix, PLATFORM_CODEBUDDY, PLATFORM_WORKBUDDY,
};
use super::model_context::{recommend_context_window, recommend_max_output_tokens};
use super::platform_enum::Platform;


// ─── 辅助函数 ──────────────────────────────────────────────────

/// 用户自行配置的字段：供应商条目（codebuddy_model_entry / workbuddy_model_entry）
/// 不会生成这些键，因此合并时需要显式从旧条目搬过来。
pub(in crate::commands::platforms) const CODEBUDDY_USER_FIELDS: &[&str] = &[
    "temperature",
    "modelId",
    "maxImageCount",
    "disabledMultimodal",
    "reasoning",
    "enabled",
    // 思考开关：与 reasoning 一样属于用户在弹窗里配置的项，
    // 供应商重新应用时必须原样搬过来，否则「仅思考模型」会被冲掉。
    //
    // 注意 supportsReasoning 刻意**不在**此列表：它由 codebuddy_supports_reasoning
    // 的命名启发式生成，保留旧值会让推断词表的改进对已有条目永久失效。
    "onlyReasoning",
];


pub(in crate::commands::platforms) fn upsert_models_json_entry(
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
        if item.get("id").and_then(Value::as_str) != Some(model_id) {
            continue;
        }
        let old = item.as_object().cloned().unwrap_or_default();

        // 换了供应商（接口地址或密钥变了）：直接用新条目，不继承旧模型的个性化配置。
        let same_provider = old.get("url").and_then(Value::as_str)
            == new_model.get("url").and_then(Value::as_str)
            && old.get("apiKey").and_then(Value::as_str)
                == new_model.get("apiKey").and_then(Value::as_str);
        if !same_provider {
            *item = new_model.clone();
            replaced = true;
            break;
        }

        // 同一供应商：以供应商条目为基底，把用户自行配置的字段搬过来。
        // 上下限也保留旧值，让用户针对渠道限制做的手工修正（如输出上限 32000）
        // 不会在点「应用」时被推荐值冲掉；新条目仍会用推荐值兜底。
        let mut merged = new_model.as_object().cloned().unwrap_or_default();
        for key in CODEBUDDY_USER_FIELDS {
            if let Some(value) = old.get(*key) {
                merged.insert((*key).to_string(), value.clone());
            }
        }
        for key in ["maxInputTokens", "maxOutputTokens"] {
            if let Some(value) = old.get(key) {
                merged.insert(key.to_string(), value.clone());
            }
        }
        *item = Value::Object(merged);
        replaced = true;
        break;
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


pub(in crate::commands::platforms) fn codebuddy_model_id(p: &Provider) -> String {
    let model = p.default_model.trim();
    if model.is_empty() {
        format!("byok-{}", sanitize_codebuddy_id(&p.id))
    } else {
        model.to_string()
    }
}


pub(in crate::commands::platforms) fn sanitize_codebuddy_id(value: &str) -> String {
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


pub(in crate::commands::platforms) fn buddy_display_name(p: &Provider, model_id: &str) -> String {
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


/// CodeBuddy / WorkBuddy 共用的 models.json 写入（数组 upsert）。
///
/// 两个平台此前各有一份逐字相同的 apply 壳与 25/27 行的 entry 构造，
/// 唯一差异是 WorkBuddy 的 `useCustomProtocol`。收敛成一处，
/// 新增同类平台只需再加一个 `true/false` 调用。
pub(in crate::commands::platforms) fn buddy_stash_key(platform: &'static str) -> crate::commands::agent_stash::StashKey {
    crate::commands::agent_stash::StashKey {
        platform,
        file: "models.json",
    }
}


/// Buddy（CodeBuddy/WorkBuddy 同构）接入：受管字段 = models 数组中
/// `id == codebuddy_model_id(p)` 的条目（数组按 id 记账）。
pub(in crate::commands::platforms) fn apply_buddy_models_json(
    path: &PathBuf,
    p: &Provider,
    use_custom_protocol: bool,
) -> Result<(), String> {
    apply_buddy_models_json_with_stash(path, p, use_custom_protocol, &agent_stash_dir())
}


pub(in crate::commands::platforms) fn apply_buddy_models_json_with_stash(
    path: &PathBuf,
    p: &Provider,
    use_custom_protocol: bool,
    stash_dir: &Path,
) -> Result<(), String> {
    let raw = if path.exists() {
        fs::read_to_string(path).map_err(|e| e.to_string())?
    } else {
        String::new()
    };
    let mut obj = parse_json_object(&raw, "models.json")?;
    let model_id = codebuddy_model_id(p);
    let entry = buddy_model_entry(p, &p.api_key, use_custom_protocol);

    // 记账：models 数组中同 id 条目（original 幂等；数组按 id 记账）
    let current = obj
        .get("models")
        .and_then(Value::as_array)
        .and_then(|arr| {
            arr.iter()
                .find(|item| item.get("id").and_then(Value::as_str) == Some(model_id.as_str()))
        })
        .cloned()
        .and_then(|v| crate::commands::agent_stash::Stashed::from_json_any(&v))
        .unwrap_or(crate::commands::agent_stash::Stashed::Absent);
    let platform_key = if use_custom_protocol {
        buddy_stash_key("workbuddy")
    } else {
        buddy_stash_key("codebuddy")
    };
    let plans = vec![crate::commands::agent_stash::FieldPlan {
        path: vec!["models".into(), model_id.clone()],
        current,
        new: crate::commands::agent_stash::Stashed::Json(entry.to_string()),
    }];
    if let Err(e) = crate::commands::agent_stash::record_apply(stash_dir, &platform_key, &plans) {
        eprintln!("[agent-stash] Buddy 记账失败（不影响切换）: {e}");
    }

    upsert_models_json_entry(&mut obj, &model_id, entry)?;
    let json = serde_json::to_string_pretty(&Value::Object(obj)).map_err(|e| e.to_string())?;
    crate::commands::write_atomic(path, json.as_bytes())
}


/// Buddy 字段级还原（数组按 id）。restore() 无参入口用。
pub(in crate::commands::platforms) fn restore_buddy_fields_via_stash(
    path: &PathBuf,
    platform: &'static str,
    stash_dir: &Path,
) -> Result<bool, String> {
    crate::commands::field_restore::restore_json_array_by_id_via_stash(
        path,
        &buddy_stash_key(platform),
        stash_dir,
        "Buddy",
    )
}


pub(in crate::commands::platforms) fn buddy_model_entry(p: &Provider, api_key: &str, use_custom_protocol: bool) -> Value {
    let model_id = codebuddy_model_id(p);
    let display_name = buddy_display_name(p, &model_id);

    let caps = p
        .model_caps
        .get(p.default_model.trim())
        .cloned()
        .unwrap_or_default();

    // 新版 WorkBuddy / CodeBuddy 仅当 vendor == "user" 时识别为自定义模型；
    // 写入供应商名会被归到「第三方模型」并可能覆盖官方同名模型。
    //
    // WorkBuddy 额外要 useCustomProtocol=true（此时客户端不再拼接路径，
    // url 必须是完整 /v1/chat/completions 端点——codebuddy_chat_url 已满足）。
    let mut entry = serde_json::json!({
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
    });
    if use_custom_protocol {
        entry["useCustomProtocol"] = Value::Bool(true);
    }
    entry
}


/// 推断上游模型是否支持思考/推理档位。
///
/// AnyBridge 手里没有权威的能力数据源（`ProviderCapabilities` 只有 text/stream/vision/tools），
/// 所以按模型族命名做启发式判断，结果只作为**首次写入时的默认值**；
/// 该键已列入 `CODEBUDDY_USER_FIELDS`，用户在编辑弹窗里勾选后不会被供应商重新应用覆盖。
///
/// 按「型号段」匹配而不是整串包含，避免同族的非推理小版本被误判（例如 glm-4-flash）。
pub(in crate::commands::platforms) fn codebuddy_supports_reasoning(model: &str) -> bool {
    let m = model.to_ascii_lowercase();

    // 显式标记 + OpenAI 推理系（o1/o3/o4 系列只匹配开头，避免命中任意含 o1 的名称）
    if m.contains("reason") || m.contains("thinking") || m.contains("deepseek-r1") || m == "r1" {
        return true;
    }
    if ["o1", "o3", "o4", "o5"].iter().any(|p| m.starts_with(p)) {
        return true;
    }

    // 各厂商的思考 / 混合推理型号段
    const REASONING_MODEL_SEGMENTS: &[&str] = &[
        "gpt-oss",
        "gpt-5",
        "gpt-6",
        "qwen3",
        "glm-4.5",
        "glm-4.6",
        "glm-5",
        "kimi-k2",
        "kimi-k3",
        "minimax-m2",
        "grok-4",
        "grok-3-mini",
        "gemini-3",
        "gemini-2.5",
        "deepseek-v3.1",
        "deepseek-v3.2",
        "deepseek-v4",
        "claude-3-7",
        "claude-sonnet-4",
        "claude-opus-4",
        "claude-opus-5",
        "claude-haiku-4",
    ];
    REASONING_MODEL_SEGMENTS.iter().any(|seg| m.contains(seg))
}


pub(in crate::commands::platforms) fn is_official_dashscope_hostname(host: &str) -> bool {
    matches!(
        host,
        "dashscope.aliyuncs.com" | "dashscope-intl.aliyuncs.com" | "dashscope-us.aliyuncs.com"
    )
}


pub(in crate::commands::platforms) fn codebuddy_chat_url(p: &Provider) -> String {
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


pub(in crate::commands::platforms) fn codebuddy_config_path(platform: &str) -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or("无法定位用户主目录")?;
    let dir = match platform {
        PLATFORM_CODEBUDDY => home.join(".codebuddy"),
        PLATFORM_WORKBUDDY => home.join(".workbuddy"),
        _ => return Err(format!("未知 CodeBuddy 平台: {platform}")),
    };
    Ok(dir.join("models.json"))
}


/// 项目级配置目录。
///
/// 桌面应用的当前工作目录由启动方式决定：macOS 从 Finder/Launchpad 启动是 `/`，
/// Windows 从开始菜单启动是安装目录（Program Files），Linux 从 .desktop 启动是 $HOME。
/// 它不代表任何项目，用它推断项目级配置会把 models.json 写到系统目录
/// （Windows 上还会触发 UAC 虚拟化，导致保存结果「消失」）。
/// 因此桌面端只支持用户级配置，项目级必须显式报错而不是猜路径。
pub(in crate::commands::platforms) fn codebuddy_project_config_path(platform: &str) -> Result<PathBuf, String> {
    let dir_name = match platform {
        PLATFORM_CODEBUDDY => ".codebuddy",
        PLATFORM_WORKBUDDY => ".workbuddy",
        _ => return Err(format!("未知 CodeBuddy 平台: {platform}")),
    };
    Err(format!(
        "桌面端无法确定 {dir_name} 的项目级配置目录（当前工作目录不指向任何项目），请改用用户级配置 (~/{dir_name}/models.json)"
    ))
}


pub(in crate::commands::platforms) fn codebuddy_config_path_for_scope(platform: &str, scope: Option<&str>) -> Result<PathBuf, String> {
    match scope.unwrap_or("user") {
        "project" => codebuddy_project_config_path(platform),
        "user" | "" => codebuddy_config_path(platform),
        other => Err(format!("未知配置作用域: {other}")),
    }
}


pub(in crate::commands::platforms) fn codebuddy_load_candidate(platform: &str) -> Result<(PathBuf, &'static str), String> {
    Ok((codebuddy_config_path(platform)?, "user"))
}


pub(in crate::commands::platforms) fn attach_codebuddy_config_meta(
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

impl Platform {

    pub(in crate::commands::platforms) fn apply_codebuddy(&self, path: &PathBuf, p: &Provider) -> Result<(), String> {
        // CodeBuddy / WorkBuddy 同一形状（models.json 数组 upsert），
        // 唯一差异是 WorkBuddy 多一个 useCustomProtocol 字段。
        apply_buddy_models_json(path, p, false)
    }


    pub(in crate::commands::platforms) fn apply_workbuddy(&self, path: &PathBuf, p: &Provider) -> Result<(), String> {
        apply_buddy_models_json(path, p, true)
    }

}
